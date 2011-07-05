var Util = require("util"),
    Net = require("net"),
    EventEmitter = require("events").EventEmitter,
    Parser = require("./ftp_parser"),
    debug = function(){}

var FTP = module.exports = function(options) {
    this.$socket = null;
    this.$dataSock = null;
    this.$state = null;
    this.$pasvPort = null;
    this.$pasvIP = null;
    this.$feat = null;
    this.$queue = [];
    this.options = {
        host: "localhost",
        port: 21,
        /*secure: false,*/
        connTimeout: 10000, // in ms
        debug: false/*,
        active: false*/ // if numerical, is the port number, otherwise should be false
        // to indicate use of passive mode
    };
    this.options = $merge(this.options, options);
    // Set TimeZone hour difference to get the server's LIST offset.
    FTP.TZHourDiff = this.options.TZHourDiff || 0;
    // Current working directory
    FTP.Cwd = this.options.cwd || "/";
    
    if (typeof this.options.debug === "function")
        debug = this.options.debug;
};

Util.inherits(FTP, EventEmitter);

(function() {
    this.EMPTY_PATH = "";
    
    function makeError(code, text) {
        var err = new Error("Server Error: " + code + (text ? " " + text : ""));
        err.code = code;
        err.text = text;
        return err;
    }
    
    // Many FTP implementations are not compatible with paths containing whitespaces,
    // therefore we must CWD before commands.
    this.$changeToPath = function(path, next) {
        var parts = path.split("/");
        var node = parts.pop();
        path = parts.join("/").replace(/[\/]+$/, "");
        if (path == FTP.Cwd)
            return next(FTP.Cwd, node);
        
        if (path.charAt(0) != "/")
            path = "/" + path;
        
        this.cwd(path, function(err) {
            if (err)
                return next(err);
            
            next(FTP.Cwd = path, node);
        });
    }
    
    this.end = function() {
        if (this.$socket)
            this.$socket.end();
        if (this.$dataSock)
            this.$dataSock.end();

        this.$socket = null;
        this.$dataSock = null;
    };
    
    this.connect = function(port, host) {
        var _self = this, socket = this.$socket, curData = "";
        this.options.port = port = port || this.options.port;
        this.options.host = host = host || this.options.host;

        this.$feat = {};

        if (socket)
            socket.end();
        if (this.$dataSock)
            this.$dataSock.end();

        var connTimeout = setTimeout(function() {
            if (_self.$socket) {
                _self.$socket.destroy();
                _self.$socket = null;
            }
            _self.emit("timeout");
        }, this.options.connTimeout);
        
        socket = this.$socket = Net.createConnection(port, host);
        socket.setEncoding("utf8");
        socket.setTimeout(0);
        socket.on("connect", function() {
            clearTimeout(connTimeout);
            if (debug) debug("Connected");
        });
        socket.on("timeout", function(err) {
            if (debug) debug("Socket timeout");
            this.emit("close");
            _self.emit("timeout", new Error("The connection to the server timed out"));
        });
        socket.on("end", function() {
            if (debug) debug("Disconnected");
            if (_self.$dataSocket)
                self.$dataSocket.end();
            _self.emit("end");
        });
        socket.on("close", function(hasError) {
            clearTimeout(connTimeout);
            if (_self.$dataSocket)
                _self.$dataSocket.end();
            _self.$state = null;
            _self.emit("close", hasError);
        });
        socket.on("error", function(err) {
            _self.end();
            _self.$state = null;
            _self.emit("error", err);
        });
        socket.on("data", function(data) {
            curData += data;
            if (/(?:\r\n|\n)$/.test(curData)) {
                var resps = Parser.parseResponses(curData.split(/\r\n|\n/)),
                    processNext = false;
                
                if (resps.length === 0)
                    return;
                
                curData = "";
                if (debug) {
                    for (var i=0, len=resps.length; i < len; ++i)
                        debug("Response: code = " + resps[i][0]
                            + (resps[i][1] ? "; text = " + Util.inspect(resps[i][1]) : ""));
                }
                for (var i=0, code, text, group, len = resps.length; i < len; ++i) {
                    code = resps[i][0];
                    text = resps[i][1];
                    group = Parser.getGroup(code); // second digit

                    if (!_self.$state) {
                        if (code === 220) {
                            _self.$state = "connected";
                            _self.send("FEAT", function(err, text) {
                                if (!err && /\r\n|\n/.test(text)) {
                                    var feats = text.split(/\r\n|\n/);
                                    feats.shift(); // "Features:"
                                    feats.pop(); // "End"
                                    for (var i=0, sp, len = feats.length; i < len; ++i) {
                                        feats[i] = feats[i].trim();
                                        if ((sp = feats[i].indexOf(" ")) > -1)
                                            _self.$feat[feats[i].substring(0, sp).toUpperCase()] = feats[i].substring(sp + 1);
                                        else
                                            _self.$feat[feats[i].toUpperCase()] = true;
                                    }
                                    if (debug) debug("Features: " + Util.inspect(_self.$feat));
                                    _self.emit("feat", _self.$feat);
                                }
                                _self.emit("connect", _self.options.host, _self.options.port);
                            });
                        } else {
                             _self.emit("error", new Error("Did not receive service ready response"));
                        }
                        return;
                    }
                    
                    if (code >= 200 && !processNext) {
                        processNext = true;
                        if (code >= 500)
                            return _self.$executeNext(makeError(code, text));
                    }
                    else if (code < 200)
                        continue;
                    
                    switch(group) {
                        case 0: // all in here are errors except 200
                            if (code === 200)
                                _self.$executeNext();
                            else
                                _self.$executeNext(makeError(code, text));
                        break;
                        case 1: // informational group
                            if (code >= 211 && code <= 215)
                                _self.$executeNext(text);
                            else
                                _self.$executeNext(makeError(code, text));
                        break;
                        case 2: // control/data connection-related
                            if (code === 226) {
                                // closing data connection, file action request successful
                                _self.$executeNext();
                            } else if (code === 227) {
                                // server entering passive mode
                                var parsed = text.match(/([\d]+),([\d]+),([\d]+),([\d]+),([-\d]+),([-\d]+)/);
                                if (!parsed)
                                    throw new Error("Could not parse passive mode response: " + text);
                                _self.$pasvIP = parsed[1] + "." + parsed[2] + "." + parsed[3] + "." + parsed[4];
                                _self.$pasvPort = (parseInt(parsed[5]) * 256) + parseInt(parsed[6]);
                                // call $executeNext after having dataSocket connected, then wait for response.
                                return _self.$pasvConnect();
                            } else
                                _self.$executeNext(makeError(code, text));
                        break;
                        case 3: // authentication-related
                            if (code === 331 || code === 230)
                                _self.$executeNext((code === 331));
                            else
                                _self.$executeNext(makeError(code, text));
                            
                        break;
                        /*case 4: // not used */
                        case 5: // server file system state
                            if (code === 250 && _self.$queue.length && _self.$queue[0][0] === "MLST")
                                _self.$executeNext(text);
                            else if (code === 250 || code === 350)
                                _self.$executeNext();
                            else if (code === 257) {
                                var path = text.match(/(?:^|\s)\"(.*)\"(?:$|\s)/);
                                if (path)
                                    path = path[1].replace(/\"\"/g, '"');
                                else
                                    path = text;
                                _self.$executeNext(path);
                            } else
                                _self.$executeNext(makeError(code, text));
                        break;
                    }
                }
                if (processNext) _self.send();
            }
        });
    };
    /** Standard features */
    this.auth = function(user, password, callback) {
        if (this.$state !== "connected")
            return false;
        
        if (typeof user === "function") {
            callback = user;
            user = "anonymous";
            password = "anonymous@";
        } else if (typeof password === "function") {
            callback = password;
            password = "anonymous@";
        }
        var cmds = [["USER", user], ["PASS", password]], cur = 0, _self = this,
            next = function(err, result) {
                if (err)
                    return callback(err);

                if (result === true) {
                    if (!_self.send(cmds[cur][0], cmds[cur][1], next))
                        return callback(new Error("Connection severed"));
                    ++cur;
                } else if (result === false) { // logged in
                    cur = 0;
                    _self.$state = "authorized";
                    if (!_self.send("TYPE", "I", callback))
                        return callback(new Error("Connection severed"));
                }
            };
        
        this.emit("auth");
        next(null, true);
        return true;
    };
    this.pwd = function(callback) {
        return (this.$state !== "authorized")
            ? false
            : this.send("PWD", callback)
    };
    this.cwd = function(path, callback) {
        return (this.$state !== "authorized")
            ? false
            : this.send("CWD", path, callback);
    };
    /** File functionality */
    this.get = function(path, callback) {
        if (this.$state !== "authorized")
            return false;

        var _self = this;
        return this.send("PASV", function(err, stream) {
            if (err)
                return callback(err);

            var buffer = [];
            stream.on("data", function(chunk) {
                buffer.push(chunk);
            });
            _self.$changeToPath(path, function(path, node) {
                var result = _self.send("RETR", node, function(err) {
                    if (err)
                        return callback(err);

                    callback(undefined, new Buffer(buffer.join("")));
                });
                if (!result)
                    callback(new Error("Connection severed"));
            });
        });
    };
    this.put = function(buffer, destpath, callback, append) {
        if (this.$state !== "authorized")
            return false;

        if (!Buffer.isBuffer(buffer))
            throw new Error("Write data must be an instance of Buffer");

        var _self = this;
        return this.send("PASV", function(err, stream) {
            if (err)
                return callback(err);
            
            _self.$changeToPath(destpath, function(path, node) {
                var res = _self.send(append ? "APPE" : "STOR", node, callback);
                stream.write(buffer, function() {
                    stream._shutdown();
                });
                if (!res)
                    callback(new Error("Connection severed"));
            });
        });
    };
    this.append = function(buffer, destpath, callback) {
        this.put.apply(this, ([].slice.call(arguments)).push(true));
    };
    this.copy = function(origpath, destpath, callback) {
        if (this.$state !== "authorized")
            return false;
        
        callback();
        //@todo dir copy involves deep recursive copying
    };
    this["delete"] = function(path, callback) {
        if (this.$state !== "authorized")
            return false;
        
        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.send("DELE", node, callback);
        });
    };
    this.rename = function(pathFrom, pathTo, callback) {
        if (this.$state !== "authorized")
            return false;

        var _self = this, ret;
        this.$changeToPath(pathFrom, function(path, node) {
            _self.send("RNFR", node, function(err) {
                if (err)
                    return callback(err);
                
                node = pathTo.split("/").pop().join("").replace(/[\/]+$/, "");
                if (path.charAt(0) != "/")
                    node = "/" + node;
                
                if (!_self.send("RNTO", node, callback))
                    callback(new Error("Connection severed"));
            });
        });
    };
    /** Directory functionality */
    this.mkdir = function(path, callback) {
        if (this.$state !== "authorized")
            return false;
        
        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.send("MKD", node, callback);
        });
    };
    this.rmdir = function(path, callback) {
        if (this.$state !== "authorized")
            return false;
        
        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.send("RMD", node, callback);
        });
    };
    /** Convenience methods */
    var Stat = function(struct) {
        this.uid    = struct.owner;
        this.gid    = struct.group;
        this.date   = struct.date;
        this.time   = struct.time;
        this.size   = struct.size;
        this.name   = struct.name;
        this.rights = struct.rights;

        /** Not recommended, it usually will return the time according
          * to the server's own Timezone shell settings */
        this.getLastMod = function(type) {
            var joinDateArr = [], joinTimeArr = [];
            for (var d in struct.date)
                joinDateArr.push(struct.date[d]);
            for (var t in struct.time)
                joinTimeArr.push(struct.time[t]);
            
            if (type === undefined || type === "LIST") {
                var intHours = FTP.TZHourDiff < 0 ? FTP.TZHourDiff * -1 : FTP.TZHourDiff;
                var hours = FTP.TZHourDiff > 0 ? ("-0"+intHours+"00") : ("+0"+intHours+"00");
                
                return new Date(joinDateArr.join(" ") +" "+ joinTimeArr.join(":") +" GMT "+ hours);
            }
            else if (type === "MLSD")
                return new Date(joinDateArr.join(" ") +" "+ joinTimeArr.join(":") +" UTC");
        };
        /**
        * @type {Boolean}
        */
        this.isFile = function() {
            return struct.type == "-";
        };
        /**
        * @type {Boolean}
        */
        this.isDirectory = function() {
            return struct.type == "d";
        };
        /**
        * @type {Boolean}
        */
        this.isBlockDevice = function() {
            return struct.type == "b";
        };
        /**
        * @type {Boolean}
        */
        this.isCharacterDevice = function() {
            return struct.type == "c";
        };
        /**
        * @type {Boolean}
        */
        this.isSymbolicLink = function() {
            return struct.type == "l";
        };
        /**
        * @type {Boolean}
        */
        this.isFIFO = function() {
            return struct.type == "p";
        };
        /**
        * @type {Boolean}
        */
        this.isSocket = function() {
            return struct.type == "s";
        };
    };
    this.readdir = function(path, callback) {
        if (debug) debug("READ DIR " + path);
        
        var _self = this;        
        this.$changeToPath(path, function(path, node) {
            _self.list(path, function(err, emitter) {
                if (err)
                    return callback(err);

                var nodes = [];
                emitter.on("entry", function(entry) {
                    nodes.push(new Stat(entry));
                });
                emitter.on("error", function(err) { // Under normal circumstances this shouldn't happen.
                    _self.$socket.end();
                    callback("Error during LIST(): " + Util.inspect(err));
                });
                emitter.on("success", function() {
                    callback(null, nodes);
                });
            });
        });
    };

    this.stat = this.lstat = this.fstat = function(path, callback) {
        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.list(FTP.EMPTY_PATH, function(err, emitter) {
                if (err)
                    return callback(err);
                
                var list = [];
                emitter.on("entry", function(entry) {
                    entry = new Stat(entry);
                    if (entry.name === node)
                        list.push(entry);
                });
                emitter.on("error", function(err) { // Under normal circumstances this shouldn"t happen.
                    _self.$socket.end();
                    callback("Error during LIST(): " + Util.inspect(err));
                });
                emitter.on("success", function() {
                    if (list.length === 0)
                        return callback("File at location " + path + "/" + node + " not found");
                    callback(null, list[0]);
                });
            });
        });
    };
    /** FTP true 'ls' command */
    this.list = function(path, callback) {
        if (this.$state !== "authorized")
            return false;

        if (typeof path === "function") {
            callback = path;
            path = undefined;
        }
        var _self = this, emitter = new EventEmitter(), params;
        /*if (params = this.$feat['MLST']) {
            var type = undefined,
            cbTemp = function(err, text) {
                if (err) {
                    if (!type && err.code === 550) { // path was a file not a dir.
                        type = 'file';
                        if (!self.send('MLST', path, cbTemp))
                            return callback(new Error('Connection severed'));
                        return;
                    } else if (!type && err.code === 425) {
                        type = 'pasv';
                        if (!self.$pasvGetLines(emitter, 'MLSD', cbTemp))
                            return callback(new Error('Connection severed'));
                        return;
                    }
                    if (type === 'dir')
                        return emitter.emit('error', err);
                    else
                        return callback(err);
                }
                if (type === 'file') {
                    callback(undefined, emitter);
                    var lines = text.split(/\r\n|\n/), result;
                    lines.shift();
                    lines.pop();
                    lines.pop();
                    result = Parser.parseMList(lines[0]);
                    emitter.emit((typeof result === 'string' ? 'raw' : 'entry'), result);
                    emitter.emit('end');
                    emitter.emit('success');
                } else if (type === 'pasv') {
                    type = 'dir';
                    if (path)
                        r = self.send('MLSD', path, cbTemp);
                    else
                        r = self.send('MLSD', cbTemp);
                    if (r)
                        callback(undefined, emitter);
                    else
                        callback(new Error('Connection severed'));
                } else if (type === 'dir')
                        emitter.emit('success');
            };
            if (path)
                return this.send('MLSD', path, cbTemp);
            else
                return this.send('MLSD', cbTemp);
        } else {*/
            // Otherwise use the standard way of fetching a listing
            this.$pasvGetLines(emitter, "LIST", function(err) {
                if (err)
                    return callback(err);
                
                var result,
                    cbTemp = function(err) {
                        if (err)
                            return emitter.emit("error", err);
                        emitter.emit("success");
                    };
                if (path)
                    result = _self.send("LIST", path, cbTemp);
                else
                    result = _self.send("LIST", cbTemp);
                if (result)
                    callback(undefined, emitter);
                else
                    callback(new Error("Connection severed"));
            });
        //}
    };
    
    this.system = function(callback) {
        return (this.$state !== "authorized")
            ? false
            : this.send("SYST", callback);
    };
    this.status = function(callback) {
        return (this.$state !== "authorized")
            ? false
            : this.send("STAT", callback);
    };
    /** Extended features */
    this.chmod = function(path, mode, callback) {
        if (this.$state !== "authorized")
            return false;
        
        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.send("SITE CHMOD", [mode, node].join(" "), callback);
        });
    };
    this.size = function(path, callback) {
        if (this.$state !== "authorized" || !this.$feat["SIZE"])
            return false;
        
        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.send("SIZE", node, callback);
        });
    };
    
    var reXTimeval = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d+)$/;
    
    this.lastMod = function(path, callback) {
        if (this.$state !== "authorized" || !this.$feat["MDTM"])
            return false;
        
        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.send("MDTM", node, function(err, text) {
                if (err)
                    return callback(err);

                var val = reXTimeval.exec(text);
                if (!val)
                    return callback(new Error("Invalid date/time format from server"));

                var date = {
                    year: parseInt(val[1], 10),
                    month: parseInt(val[2], 10),
                    date: parseInt(val[3], 10)
                };
                var time = {
                    hour: parseInt(val[4], 10),
                    minute: parseInt(val[5], 10),
                    second: parseFloat(val[6], 10)
                };
                var joinDateArr = [], joinTimeArr = [];
                for (var d in date)
                    joinDateArr.push(date[d]);
                for (var t in time)
                    joinTimeArr.push(time[t]);

                var mdtm = new Date(joinDateArr.join(" ") + " " + joinTimeArr.join(":") + " GMT");
                callback(undefined, mdtm);
            });
        });
    };
    this.restart = function(offset, callback) {
        return (this.$state !== "authorized" || !this.$feat["REST"] || !(/STREAM/i.test(this.$feat["REST"])))
            ? false
            : this.send("REST", offset, callback);
    };
    /** Internal helper methods */
    this.send = function(cmd, params, callback) {
        if (!this.$socket || !this.$socket.writable)
            return false;

        if (cmd) {
            cmd = ("" + cmd).toUpperCase();
            if (typeof params === "function") {
                callback = params;
                params = undefined;
            }
            if (!params || params == FTP.EMPTY_PATH)
                this.$queue.push([cmd, callback]);
            else
                this.$queue.push([cmd, params, callback]);
        }
        
        if (this.$queue.length) { 
            var fullcmd = this.$queue[0][0] + (this.$queue[0].length === 3 ? " " + this.$queue[0][1] : "");
            if (debug)
                debug("> " + fullcmd);
            this.emit("command", fullcmd);
            // WRITE COMMAND AND ARGUMENTS TO THE SOCKET:
            this.$socket.write(fullcmd + "\r\n");
        }

        return true;
    };
    
    this.$pasvGetLines = function(emitter, type, callback) {
        return this.send("PASV", function(err, stream) {
            if (err)
                return callback(err);
            else if (!emitter)
                return emitter.emit("error", new Error("Connection severed"));
            else if (stream && !stream.readable)
                return callback(err || new Error("Stream not readable"));
            
            var curData = "", lines;
            stream.setEncoding("utf8");
            // Note: stream will start transfering by cmd "LIST"
            stream.on("data", function(data) {
                curData += data;
                if (/\r\n|\n/.test(curData)) {
                    if (curData[curData.length-1] === "\n") {
                        lines = curData.split(/\r\n|\n/);
                        curData = "";
                    } else {
                        var pos = curData.lastIndexOf("\r\n");
                        if (pos === -1)
                            pos = curData.lastIndexOf("\n");
                        lines = curData.substring(0, pos).split(/\r\n|\n/);
                        curData = curData.substring(pos + 1);
                    }
                    for (var results = Parser.processDirLines(lines, type), i = 0; i < results.length; i++) {
                        if (debug)
                            debug("(PASV) Got " + type + " line: " + results[i][2]);
                        emitter.emit(results[i][0]/*event*/, results[i][1]/*result*/);
                    }
                }
            });
            stream.on("end", function() {
                emitter.emit("end");
            });
            stream.on("error", function(err) {
                emitter.emit("error", err);
            });
            
            callback();
        });
    };
    
    this.$pasvConnect = function() {
        if (!this.$pasvPort)
            return false;

        var _self = this;
        var pasvTimeout = setTimeout(function() {
            var result = _self.send("ABOR", function(err) {
                if (err)
                    return _self.$executeNext(err);
                _self.$dataSock.destroy();
                _self.$dataSock = _self.$pasvPort = _self.$pasvIP = null;
                _self.$executeNext(new Error("(PASV) Data connection timed out while connecting"));
            });
            if (!result)
                _self.$executeNext(new Error("Connection severed"));
        }, this.options.connTimeout);

        if (debug) debug("(PASV) About to attempt data connection to: " + this.$pasvIP + ":" + this.$pasvPort);
        // Create new passive stream.
        this.$dataSock = Net.createConnection(this.$pasvPort, this.$pasvIP);

        this.$dataSock.on("connect", function() {
            clearTimeout(pasvTimeout);
            if (debug) debug("(PASV) Data connection successful");
            _self.$executeNext(_self.$dataSock);
        });
        this.$dataSock.on("end", function() {
            if (debug) debug("(PASV) Data connection closed");
            _self.$dataSock = _self.$pasvPort = _self.$pasvIP = null;
        });
        this.$dataSock.on("close", function() {
            clearTimeout(pasvTimeout);
        });
        this.$dataSock.on("error", function(err) {
            if (debug) debug("(PASV) Error: " + err);
            
            _self.$executeNext(err);
            _self.$dataSock = _self.$pasvPort = _self.$pasvIP = null;
        });

        return true;
    };
    
    this.$executeNext = function(result) {
        if (!this.$queue.length)
            return;

        var p = this.$queue.shift();
        var callback = (p.length === 3 ? p[2] : p[1]);
        
        if (!callback)
            return;

        if (result instanceof Error) {
            process.nextTick(function() {
                callback(result);
            });
        } else if (typeof result !== "undefined") {
            process.nextTick(function() {
                callback(undefined, result);
            });
        } else
            process.nextTick(callback);
    };
}).call(FTP.prototype);

/*
* Recursively merge properties of two objects 
*/
function $merge(destObj, fromObj) {
    for (var p in fromObj) {
        if (!destObj.hasOwnProperty(p))
            destObj[p] = fromObj[p];
        else if (obj2[p].constructor==Object)
            destObj[p] = $merge(obj1[p], obj2[p]);
        else
            destObj[p] = fromObj[p];
    }
    return destObj;
}

// Target API:
//
//  var s = require('net').createStream(25, 'smtp.example.com');
//  s.on('connect', function() {
//   require('starttls')(s, options, function() {
//      if (!s.authorized) {
//        s.destroy();
//        return;
//      }
//
//      s.end("hello world\n");
//    });
//  });
function starttls(socket, options, cb) {
    var sslcontext = require('crypto').createCredentials(options),
    pair = require('tls').createSecurePair(sslcontext, false),
    cleartext = $pipe(pair, socket);
    pair.on('secure', function() {
        var verifyError = pair._ssl.verifyError();
        if (verifyError) {
            cleartext.authorized = false;
            cleartext.authorizationError = verifyError;
            } else
            cleartext.authorized = true;
            if (cb)
            cb();
    });
    cleartext._controlReleased = true;
    return cleartext;
}

function $pipe(pair, socket) {
    pair.encrypted.pipe(socket);
    socket.pipe(pair.encrypted);

    pair.fd = socket.fd;
    var cleartext = pair.cleartext;
    cleartext.socket = socket;
    cleartext.encrypted = pair.encrypted;
    cleartext.authorized = false;

    function onerror(e) {
        if (cleartext._controlReleased)
        cleartext.emit('error', e);
    }
    function onclose() {
        socket.removeListener('error', onerror);
        socket.removeListener('close', onclose);
    }
    socket.on('error', onerror);
    socket.on('close', onclose);
    return cleartext;
}