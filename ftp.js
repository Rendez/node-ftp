var Util = require('util'),
    Net = require('net'),
    EventEmitter = require('events').EventEmitter,
    Parser = require('./ftp_parser'),
    debug = function(){}

var FTP = module.exports = function(options) {
    this.$socket = null;
    this.$dataSock = null;
    this.$state = null;
    this.$pasvPort = null;
    this.$pasvIP = null;
    this.$feat = null;
    this.$queue = [];
    this.$pasvQueue = [];
    this.$pasvStack = [];
    this.options = {
        host: 'localhost',
        port: 21,
        /*secure: false,*/
        connTimeout: 10000, // in ms
        debug: false/*,
        active: false*/ // if numerical, is the port number, otherwise should be false
        // to indicate use of passive mode
    };
    extend(true, this.options, options);
    // Set TimeZone hour difference to get the server's LIST offset.
    FTP.TZHourDiff = this.options.TZHourDiff || 0;
    
    if (typeof this.options.debug === 'function')
        debug = this.options.debug;
};

Util.inherits(FTP, EventEmitter);

(function() {
    function makeError(code, text) {
        var err = new Error('Server Error: ' + code + (text ? ' ' + text : ''));
        err.code = code;
        err.text = text;
        return err;
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
        var self = this, socket = this.$socket, curData = '';
        this.options.port = port = port || this.options.port;
        this.options.host = host = host || this.options.host;

        this.$feat = {};

        if (socket)
            socket.end();
        if (this.$dataSock)
            this.$dataSock.end();

        var connTimeout = setTimeout(function() {
            if (self.$socket) {
                self.$socket.destroy();
                self.$socket = null;
            }
            self.emit('timeout');
        }, this.options.connTimeout);
        
        socket = this.$socket = Net.createConnection(port, host);
        socket.setEncoding('utf8');
        socket.setTimeout(0);
        socket.on('connect', function() {
            clearTimeout(connTimeout);
            if (debug)
                debug('Connected');
        });
        socket.on('timeout', function(err) {
            if (debug)
                debug('Socket timeout');
            this.emit('close');
            self.emit('timeout', new Error('The connection to the server timed out'));
        });
        socket.on('end', function() {
            if (debug)
                debug('Disconnected');
            if (self.$dataSocket)
                self.$dataSocket.end();
            self.emit('end');
        });
        socket.on('close', function(hasError) {
            clearTimeout(connTimeout);
            if (self.$dataSocket)
                self.$dataSocket.end();
            self.$state = null;
            self.emit('close', hasError);
        });
        socket.on('error', function(err) {
            self.end();
            self.$state = null;
            self.emit('error', err);
        });
        socket.on('data', function(data) {
            curData += data;
            if (/(?:\r\n|\n)$/.test(curData)) {
                var resps = Parser.parseResponses(curData.split(/\r\n|\n/)),
                    processNext = false;
                
                if (resps.length === 0)
                    return;
                
                curData = '';
                if (debug) {
                    for (var i=0, len=resps.length; i < len; ++i)
                        debug('Response: code = ' + resps[i][0]
                            + (resps[i][1] ? '; text = ' + Util.inspect(resps[i][1]) : ''));
                }

                for (var i=0, code, text, group, len = resps.length; i < len; ++i) {
                    code = resps[i][0];
                    text = resps[i][1];
                    group = Parser.getGroup(code); // second digit

                    if (!self.$state) {
                        if (code === 220) {
                            self.$state = 'connected';
                            self.send('FEAT', function(err, text) {
                                if (!err && /\r\n|\n/.test(text)) {
                                    var feats = text.split(/\r\n|\n/);
                                    feats.shift(); // "Features:"
                                    feats.pop(); // "End"
                                    for (var i=0, sp, len = feats.length; i < len; ++i) {
                                        feats[i] = feats[i].trim();
                                        if ((sp = feats[i].indexOf(' ')) > -1)
                                            self.$feat[feats[i].substring(0, sp).toUpperCase()] = feats[i].substring(sp + 1);
                                        else
                                            self.$feat[feats[i].toUpperCase()] = true;
                                    }
                                    if (debug)
                                        debug('Features: ' + Util.inspect(self.$feat));
                                    self.emit('feat', self.$feat);
                                }
                                self.emit('connect', self.options.host, self.options.port);
                            });
                        } else {
                             self.emit('error', new Error('Did not receive service ready response'));
                        }
                        return;
                    }
                    
                    if (code >= 200 && !processNext) {
                        processNext = true;
                        switch(code) {
                            case 55: case 550: // permission denied
                                return self.$executeNext(makeError(code, text));
                        }
                    }
                    else if (code < 200)
                        continue;
                    
                    switch(group) {
                        case 0: // all in here are errors except 200
                            if (code === 200)
                                self.$executeNext();
                            else
                                self.$executeNext(makeError(code, text));
                        break;
                        case 1: // informational group
                            if (code >= 211 && code <= 215)
                                self.$executeNext(text);
                            else
                                self.$executeNext(makeError(code, text));
                        break;
                        case 2: // control/data connection-related
                            if (code === 226) {
                                // closing data connection, file action request successful
                                self.$executeNext();
                            } else if (code === 227) {
                                // server entering passive mode
                                var parsed = text.match(/([\d]+),([\d]+),([\d]+),([\d]+),([-\d]+),([-\d]+)/);
                                if (!parsed)
                                    throw new Error('Could not parse passive mode response: ' + text);
                                self.$pasvIP = parsed[1] + '.' + parsed[2] + '.' + parsed[3] + '.' + parsed[4];
                                self.$pasvPort = (parseInt(parsed[5]) * 256) + parseInt(parsed[6]);
                                // call $executeNext after having dataSocket connected, then wait for response.
                                return self.$pasvConnect();
                            } else
                                self.$executeNext(makeError(code, text));
                        break;
                        case 3: // authentication-related
                            if (code === 331 || code === 230)
                                self.$executeNext((code === 331));
                            else
                                self.$executeNext(makeError(code, text));
                            
                        break;
                        /*case 4: // not used */
                        case 5: // server file system state
                            if (code === 250 && self.$queue.length && self.$queue[0][0] === 'MLST')
                                self.$executeNext(text);
                            else if (code === 250 || code === 350)
                                self.$executeNext();
                            else if (code === 257) {
                                var path = text.match(/(?:^|\s)\"(.*)\"(?:$|\s)/);
                                if (path)
                                    path = path[1].replace(/\"\"/g, '"');
                                else
                                    path = text;
                                self.$executeNext(path);
                            } else
                                self.$executeNext(makeError(code, text));
                        break;
                    }
                }
                if (processNext) self.send();
            }
        });
    };
    /** Standard features */
    this.auth = function(user, password, callback) {
        if (this.$state !== 'connected')
            return false;
        
        if (typeof user === 'function') {
            callback = user;
            user = 'anonymous';
            password = 'anonymous@';
        } else if (typeof password === 'function') {
            callback = password;
            password = 'anonymous@';
        }
        var cmds = [['USER', user], ['PASS', password]], cur = 0, self = this,
            next = function(err, result) {
                if (err)
                    return callback(err);

                if (result === true) {
                    if (!self.send(cmds[cur][0], cmds[cur][1], next))
                        return callback(new Error('Connection severed'));
                    ++cur;
                } else if (result === false) { // logged in
                    cur = 0;
                    self.$state = 'authorized';
                    if (!self.send('TYPE', 'I', callback))
                        return callback(new Error('Connection severed'));
                }
            };
        
        this.emit('auth');
        next(null, true);
        return true;
    };
    this.pwd = function(callback) {
        return (this.$state !== 'authorized')
            ? false
            : this.send('PWD', callback)
    };
    this.cwd = function(path, callback) {
        return (this.$state !== 'authorized')
            ? false
            : this.send('CWD', path, callback);
    };
    /** File functionality */
    this.get = function(path, callback) {
        if (this.$state !== 'authorized')
            return false;

        var self = this;
        return this.send('PASV', function(err, stream) {
            if (err)
                return callback(err);
                
            var buffer = [];
            stream.on('data', function(chunk) {
                buffer.push(chunk);
            });

            var result = self.send('RETR', path, function(err) {
                if (err)
                    return callback(err);
                
                callback(null, new Buffer(buffer.join('')));
            });
            if (!result)
                callback(new Error('Connection severed'));
        });
    };
    this.put = function(buffer, destpath, callback) {
        if (this.$state !== 'authorized')
            return false;

        if (!Buffer.isBuffer(buffer))
            throw new Error('Write data must be an instance of Buffer');

        var self = this;
        return this.send('PASV', function(err, stream) {
            if (err)
                return callback(err);
            
            var res = self.send('STOR', destpath, callback);
            stream.write(buffer, function() {
                stream._shutdown();
            });
            if (!res)
                callback(new Error('Connection severed'));
        });
    };
    this.append = function(buffer, destpath, callback) {
        if (this.$state !== 'authorized')
            return false;

        if (!Buffer.isBuffer(buffer))
            throw new Error('Write data must be an instance of Buffer');

        var self = this;
        return this.send('PASV', function(err, stream) {
            if (err)
                return callback(err);
            
            var res = self.send('APPE', destpath, callback);
            stream.write(buffer, function() {
                stream._shutdown();
            });
            if (!res)
                callback(new Error('Connection severed'));
        });
    };
    this.copy = function(origpath, destpath, callback) {
        if (this.$state !== 'authorized')
            return false;
        //@todo dir copy involves deep recursive copying
    };
    this['delete'] = function(path, callback) {
        return (this.$state !== 'authorized')
            ? false
            : this.send('DELE', path, callback);
    };
    this.rename = function(pathFrom, pathTo, callback) {
        if (this.$state !== 'authorized')
            return false;

        var self = this;
        return this.send('RNFR', pathFrom, function(err) {
            if (err)
                return callback(err);

            if (!self.send('RNTO', pathTo, callback))
                callback(new Error('Connection severed'));
        });
    };
    /** Directory functionality */
    this.mkdir = function(path, callback) {
        return (this.$state !== 'authorized')
            ? false
            : this.send('MKD', path, callback);
    };
    this.rmdir = function(path, callback) {
        return (this.$state !== 'authorized')
            ? false
            : this.send('RMD', path, callback);
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
            
            if (type === undefined || type === 'LIST') {
                var intHours = FTP.TZHourDiff < 0 ? FTP.TZHourDiff * -1 : FTP.TZHourDiff;
                var hours = FTP.TZHourDiff > 0 ? ('-0'+intHours+'00') : ('+0'+intHours+'00');
                
                return new Date(joinDateArr.join(' ') +' '+ joinTimeArr.join(':') +' GMT '+ hours);
            }
            else if (type === 'MLSD')
                return new Date(joinDateArr.join(' ') +' '+ joinTimeArr.join(':') +' UTC');
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
        var self = this;
        if (debug)
            debug('READ DIR ' + path);
            
        this.list(path, function(err, emitter) {
            if (err)
                return callback(err);
                
            var nodes = [];
            emitter.on('entry', function(entry) {
                var item = new Stat(entry);
                //var p = item.name;
                nodes.push(item);
                //nodes.push(p.substr(p.lastIndexOf("/") + 1));
            });
            emitter.on('error', function(err) { // Under normal circumstances this shouldn't happen.
                self.$socket.end();
                callback('Error during LIST(): ' + Util.inspect(err));
            });
            emitter.on('success', function() {
                callback(null, nodes);
            });
        });
    };
    this.stat = this.lstat = this.fstat = function(path, callback) {
        var self = this,
            parts = path.split("/"),
            node = parts.pop(),
            root = parts.join("/");
        
        if (root.charAt(0) != "/") {
            this.pwd(function(err, pwd) {
                if (err || !pwd)
                    return callback(err || pwd);
                pwd = pwd.replace(/[\/]+$/, "");
                root = pwd + "/" + root.replace(/^[\/]+/, "");
                afterPwd();
            });
        } else
            afterPwd();

        function afterPwd() {
            // List and add to first matching result to the list
            self.list(root, function(err, emitter) {
                if (err)
                    return callback(err); // Error('Unable to retrieve node status', root);
                
                var list = [];
                emitter.on('entry', function(entry) {
                    entry = new Stat(entry);
                    if (entry.name === node)
                        list.push(entry);
                });
                emitter.on('error', function(err) { // Under normal circumstances this shouldn't happen.
                    self.$socket.end();
                    callback('Error during LIST(): ' + Util.inspect(err));
                });
                emitter.on('success', function() {
                    if (list.length === 0)
                        return callback("File at location " + path + " not found");
                    callback(null, list[0]);
                });
            });
        }
    };
    /** FTP true list command */
    this.list = function(path, callback) {
        if (this.$state !== 'authorized')
            return false;

        if (typeof path === 'function') {
            callback = path;
            path = undefined;
        }
        var self = this, emitter = new EventEmitter(), params;
        /*if (params = this.$feat['MLST']) {
        var type = undefined,
        cbTemp = function(err, text) {
        if (err) {
        if (!type && e.code === 550) { // path was a file not a dir.
        type = 'file';
        if (!self.send('MLST', path, cbTemp))
        return callback(new Error('Connection severed'));
        return;
        } else if (!type && e.code === 425) {
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
        callbac(new Error('Connection severed'));
        } else if (type === 'dir')
        emitter.emit('success');
        };
        if (path)
        return this.send('MLSD', path, cbTemp);
        else
        return this.send('MLSD', cbTemp);
        } else {*/
            // Otherwise use the standard way of fetching a listing
            this.$pasvGetLines(emitter, 'LIST', function(err) {
                if (err)
                    return callback(err);
                
                var result,
                    cbTemp = function(err) {
                        if (err)
                            return emitter.emit('error', err);
                        emitter.emit('success');
                    };
                if (path)
                    result = self.send('LIST', path, cbTemp);
                else
                    result = self.send('LIST', cbTemp);
                if (result)
                    callback(undefined, emitter);
                else
                    callback(new Error('Connection severed'));
            });
        //}
    };
    
    this.system = function(callback) {
        return (this.$state !== 'authorized')
            ? false
            : this.send('SYST', callback);
    };
    this.status = function(callback) {
        return (this.$state !== 'authorized')
            ? false
            : this.send('STAT', callback);
    };
    /** Extended features */
    this.chmod = function(path, mode, callback) {
        return (this.$state !== 'authorized')
            ? false
            : this.send('SITE CHMOD', [mode, path].join(' '), callback);
    };
    this.size = function(path, callback) {
      return (this.$state !== 'authorized' || !this.$feat['SIZE'])
        ? false
        : this.send('SIZE', path, callback);
    };
    
    var reXTimeval = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d+)$/;
    
    this.lastMod = function(path, callback) {
        if (this.$state !== 'authorized' || !this.$feat['MDTM'])
            return false;
        
        return this.send('MDTM', path, function(err, text) {
            if (err)
                return callback(err);
            
            var val = reXTimeval.exec(text);
            if (!val)
                return callback(new Error('Invalid date/time format from server'));
                
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
            
            var mdtm = new Date(joinDateArr.join(' ') + ' ' + joinTimeArr.join(':') + ' GMT');
            callback(undefined, mdtm);
        });
    };
    this.restart = function(offset, callback) {
        return (this.$state !== 'authorized' || !this.$feat['REST'] || !(/STREAM/i.test(this.$feat['REST'])))
            ? false
            : this.send('REST', offset, callback);
    };
    /** Internal helper methods */
    this.send = function(cmd, params, callback) {
        if (!this.$socket || !this.$socket.writable)
            return false;

        if (cmd) {
            cmd = (''+cmd).toUpperCase();
            if (typeof params === 'function') {
                callback = params;
                params = undefined;
            }
            if (cmd === 'PASV')
                return this.sendPasv(cmd, callback);
            else if (!params)
                this.$queue.push([cmd, callback]);
            else
                this.$queue.push([cmd, params, callback]);
        }
        
        if (this.$queue.length) { 
            var fullcmd = this.$queue[0][0] + (this.$queue[0].length === 3 ? ' ' + this.$queue[0][1] : '');
            if (debug)
                debug('> ' + fullcmd);
            this.emit('command', fullcmd);
            // WRITE COMMAND AND ARGUMENTS TO THE SOCKET:
            this.$socket.write(fullcmd + '\r\n');
        }

        return true;
    };
    this.sendPasv = function(cmd, callback) {
        // Check if dataSocket is still on the line from a previous call.
        if (this.$pasvRunning(cmd, callback))
            return true;
        
        this.$pasvQueue.push([cmd, callback]);
        if (debug)
            debug('> ' + cmd);
        this.emit('command', cmd);
        // Ask the server to switch to PASV mode
        this.$socket.write(cmd + '\r\n');

        return true;
    };
    this.$pasvRunning = function() {
        if (!this.$pasvQueue.length)
            return false;
        
        var args = Array.prototype.slice.call(arguments);
        this.$pasvStack.push(args);
        if (debug)
            debug('(QUEUE) Stacking PASV ... ');
        
        return true;
    };
    this.$pasvGetLines = function(emitter, type, callback) {
        return this.send('PASV', function(err, stream) {
            if (err)
                return callback(err);
            else if (!emitter)
                return emitter.emit('error', new Error('Connection severed'));
            else if (!stream.readable)
                return callback(err || new Error('Stream not readable'));
            
            var curData = '', lines;
            stream.setEncoding('utf8');
            // Note: stream will start transfering by cmd 'LIST'
            stream.on('data', function(data) {
                curData += data;
                if (/\r\n|\n/.test(curData)) {
                    if (curData[curData.length-1] === '\n') {
                        lines = curData.split(/\r\n|\n/);
                        curData = '';
                    } else {
                        var pos = curData.lastIndexOf('\r\n');
                        if (pos === -1)
                            pos = curData.lastIndexOf('\n');
                        lines = curData.substring(0, pos).split(/\r\n|\n/);
                        curData = curData.substring(pos + 1);
                    }
                    for (var results = Parser.processDirLines(lines, type), i = 0; i < results.length; i++) {
                        if (debug)
                            debug('(PASV) Got ' + type + ' line: ' + results[i][2]);
                        emitter.emit(results[i][0]/*event*/, results[i][1]/*result*/);
                    }
                }
            });
            stream.on('end', function() {
                emitter.emit('end');
            });
            stream.on('error', function(err) {
                emitter.emit('error', err);
            });
            
            callback();
        });
    };
    this.$pasvConnect = function() {
        if (!this.$pasvPort)
            return false;

        var self = this;
        var pasvTimeout = setTimeout(function() {
            var result = self.send('ABOR', function(err) {
                if (err)
                    return self.$executeNext(err);
                self.$dataSock.destroy();
                self.$dataSock = self.$pasvPort = self.$pasvIP = null;
                self.$executeNext(new Error('(PASV) Data connection timed out while connecting'));
            });
            if (!result)
                self.$executeNext(new Error('Connection severed'));
        }, this.options.connTimeout);

        if (debug)
            debug('(PASV) About to attempt data connection to: ' + this.$pasvIP + ':' + this.$pasvPort);
        // Create new passive stream.
        this.$dataSock = Net.createConnection(this.$pasvPort, this.$pasvIP);

        this.$dataSock.on('connect', function() {
            clearTimeout(pasvTimeout);
            if (debug)
                debug('(PASV) Data connection successful');
            self.$executeNextPasv(self.$dataSock);
        });
        this.$dataSock.on('end', function() {
            if (debug)
                debug('(PASV) Data connection closed');
            self.$dataSock = self.$pasvPort = self.$pasvIP = null;
        });
        this.$dataSock.on('close', function() {
            clearTimeout(pasvTimeout);
            // Data connection closed, send next command in the queue.
            if (self.$pasvStack.length) {
                process.nextTick(function(){
                    if (debug)
                        debug('(SEND) Queued command: ' + self.$pasvStack[0][0]);
                    self.send.apply(self, self.$pasvStack.shift());
                });
            }
        });
        this.$dataSock.on('error', function(err) {
            if (debug)
                debug('(PASV) Error: ' + err);
            
            self.$executeNext(err);
            self.$dataSock = self.$pasvPort = self.$pasvIP = null;
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
        } else if (typeof result !== 'undefined') {
            process.nextTick(function() {
                callback(undefined, result);
            });
        } else
            process.nextTick(callback);
    };
    this.$executeNextPasv = function(stream) {
        if (stream !== this.$dataSock)
            return;
        
        var p = this.$pasvQueue.shift();
        var callback = p[1] || null;
        if (!callback)
            return;
        
        process.nextTick(function(){
            callback(undefined, stream);
        });
    };
}).call(FTP.prototype);

/**
* Adopted from jquery's extend method. Under the terms of MIT License.
*
* http://code.jquery.com/jquery-1.4.2.js
*
* Modified by Brian White to use Array.isArray instead of the custom isArray method
*/
function extend() {
    // copy reference to target object
    var target = arguments[0] || {}, i = 1, length = arguments.length, deep = false, options, name, src, copy;
    // Handle a deep copy situation
    if (typeof target === "boolean") {
        deep = target;
        target = arguments[1] || {};
        // skip the boolean and the target
        i = 2;
    }
    // Handle case when target is a string or something (possible in deep copy)
    if (typeof target !== "object" && !typeof target === 'function')
    target = {};
    var isPlainObject = function(obj) {
        // Must be an Object.
        // Because of IE, we also have to check the presence of the constructor property.
        // Make sure that DOM nodes and window objects don't pass through, as well
        if (!obj || toString.call(obj) !== "[object Object]" || obj.nodeType || obj.setInterval)
        return false;
        var has_own_constructor = hasOwnProperty.call(obj, "constructor");
        var has_is_property_of_method = hasOwnProperty.call(obj.constructor.prototype, "isPrototypeOf");
        // Not own constructor property must be Object
        if (obj.constructor && !has_own_constructor && !has_is_property_of_method)
        return false;
        // Own properties are enumerated firstly, so to speed up,
        // if last one is own, then all properties are own.
        var last_key;
        for (key in obj)
            last_key = key;
        return typeof last_key === "undefined" || hasOwnProperty.call(obj, last_key);
    };
    for (; i < length; i++) {
        // Only deal with non-null/undefined values
        if ((options = arguments[i]) !== null) {
            // Extend the base object
            for (name in options) {
                src = target[name];
                copy = options[name];
                // Prevent never-ending loop
                if (target === copy)
                continue;
                // Recurse if we're merging object literal values or arrays
                if (deep && copy && (isPlainObject(copy) || Array.isArray(copy))) {
                    var clone = src && (isPlainObject(src) || Array.isArray(src)) ? src : Array.isArray(copy) ? [] : {};
                    // Never move original objects, clone them
                    target[name] = extend(deep, clone, copy);
                    // Don't bring in undefined values
                    } else if (typeof copy !== "undefined")
                    target[name] = copy;
                }
            }
        }
        // Return the modified object
        return target;
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