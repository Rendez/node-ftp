/**
 * FTP module providing explicit methods for running and handling common commands using FTP(S) protocol.
 * This implementation counts on a control-oriented socket, plus one for data transfering which is
 * precedeed by a command PASV or PORT. Data transfering encoding and mode default to TYPE binary (I)
 * and not-print (N; not destined for printing, unless the server specifies otherwise in its default config).
 *
 * Based on an implementation by Brian White <https://github.com/mscdex/node-ftp>
 *
 * @param {Object} class options
 *
 * @author Brian White <http://mscdex.net/>
 * @contributor Luis Merino <luis AT ajax DOT org>
 * @contributor Sergi Mansilla <sergi AT ajax DOT org>
 */
var _    = require("./support/underscore");
var Util = require("util");
var Net  = require("net");
var EventEmitter = require("events").EventEmitter;
var Parser = require("./ftp_parser");
var debug  = function() {};

var Ftp = module.exports = function(options) {
    this.$socket    = null;
    this.$dataSock  = null;
    this.$state     = null;
    this.$pasvPort  = null;
    this.$pasvIP    = null;
    this.$feat      = null;
    this.$queue     = [];
    this.options = _.extend({
        host: "localhost",
        port: 21,
        /*secure: false,*/
        connTimeout: 10000, // in ms
        debug: false/*,
        active: false*/ // if numerical, is the port number, otherwise should be false
        // to indicate use of passive mode
    }, options);
    // Set TimeZone hour difference to get the server's LIST offset
    this.TZHourDiff = this.options.TZHourDiff || 0;
    // Current working directory
    this.currentCwd = "/";
    // Idle timeout in seconds; defaults to 1 min
    this.idleSeconds = 60;
    
    if (_.isFunction(this.options.debug))
        debug = this.options.debug;
};

Util.inherits(Ftp, EventEmitter);

(function() {
    
    var RE_NEWLINE = /\r\n|\n/;
    var EMPTY_PATH = "";
    
    function makeError(code, text) {
        var err = new Error("Server Error: " + code + (text ? " " + text : ""));
        err.code = code;
        err.text = text;
        return err;
    }
    
    function setupIdle() {
        if (this.idleTimeout)
            clearTimeout(this.idleTimeout);
        
        var _self = this;
        this.idleTimeout = setTimeout(function() {
            /** Idle time since last command */
            _self.noop(function(err) {
                if (err)
                    return _self.emit("timeout");
                
                setupIdle.call(_self);
            });
        }, (this.idleSeconds - 10/*give a few extra secs*/) * 1000);
    }

    /**
     * Changes directory before running a command to facilitate the use of relative nodes path.
     * Some Ftp servers lack support to run commands with paths containing whitespace(s) in them,
     * specially important in commands like LIST or MLSD.
     *
     * @param {String} path to parse in order to cwd to its parent dir
     * @param {Function} callback for post-cwd
     * @param {Boolean} whether to split the last node from the path or not
     * @type {void}
     */
     this.$changeToPath = function(path, next, nosplit) {
        if (path.charAt(0) == "/")
            path = path.substring(1);
        
        var node = "";
        if (!nosplit) {
            var parts = path.replace(/[\/]*$/, "").split("/");
            path = "/" + parts.join("/");
            if (parts.length > 1) {
                node = parts.pop();
                path = "/" + parts.join("/");
            } else {
                node = parts.pop();
                path = "/";
            }
        } else if (path.charAt(0) != "/")
            path = "/" + path;
        
        if (path == this.currentCwd)
            return next(this.currentCwd, node);
        
        _self = this;
        this.cwd(path, function(err) {
            if (err)
                return next(err);
            
            next(_self.currentCwd = path, node);
        });
    };
    
    /**
     * Ends socket and data socket connections
     */
    this.end = function() {
        if (this.$socket)
            this.$socket.end();
        if (this.$dataSock)
            this.$dataSock.end();

        this.$socket   = null;
        this.$dataSock = null;
    };

    /**
     * Initiates the connection of the control socket to the specified host and
     * port. The socket data event handler will parse the responses and in most
     * cases run the next command if success or execute the next with an error
     * if this is the case. The responses are handled using the reply codes by
     * 'Function Groups' as specified in RFC 959 <http://tools.ietf.org/html/rfc959#page-39>
     *
     * @param {Number} connection port
     * @param {String} connection host name
     * @type {void}
     */
    this.connect = function(port, host) {
        var _self   = this;
        var port = port || this.options.port;
        var host = host || this.options.host;

        this.options.port = port;
        this.options.host = host;

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

        var socket = this.$socket = Net.createConnection(port, host);

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

        var curData = "";
        socket.on("data", function(data) {
            curData += data;
            if (/(?:\r\n|\n)$/.test(curData)) {
                var resps = Parser.parseResponses(curData.split(RE_NEWLINE));
                var processNext = false;

                if (resps.length === 0) return;

                curData = "";

                if (debug) {
                    resps.forEach(function(r) {
                        debug(
                            "Response: code = " + r[0] +
                            (r[1] ? "; text = " + Util.inspect(r[1]) : ""
                        ));
                    });
                }

                var i, code, text, group;
                var len = resps.length;
                for (i=0; i < len; ++i) {
                    code = resps[i][0];
                    text = resps[i][1];

                    if (!_self.$state) {
                        if (code === 220) {
                            _self.$state = "connected";
                            _self.send("FEAT", function(err, text) {
                                if (!err && RE_NEWLINE.test(text)) {
                                    // Strip "Features:" and "End"
                                    var feats = text.split(RE_NEWLINE);
                                    feats.shift();
                                    feats.pop();

                                    feats.map(function(feature) { return feature.toUpperCase(); })
                                         .forEach(function(feature) {
                                             //var RE_FEAT = /^[\s]*(\w\d)+(?:[\s]*?())/;
                                             //var match = RE_FEAT.exec(feature);
                                             feature = feature.trim();
                                             var sp = feature.indexOf(" ");

                                             if (sp > -1)
                                                 _self.$feat[feature.substring(0, sp)] = feature.substring(sp + 1);
                                             else
                                                 _self.$feat[feature] = true;
                                        });

                                    debug && debug("Features: " + Util.inspect(_self.$feat));

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
                        if (code >= 500) /** human errors first, like "bad sequence of commands" for example */
                            return _self.$executeNext(makeError(code, text));
                    }
                    else if (code < 200)
                        continue;

                 /**
                   * The following function groupings are encoded in the second
                   * digit:
                   *
                   * x0z   Syntax - These replies refer to syntax errors,
                   *       syntactically correct commands that don't fit any
                   *       functional category, unimplemented or superfluous
                   *       commands.
                   *
                   * x1z   Information -  These are replies to requests for
                   *       information, such as status or help.
                   *
                   * x2z   Connections - Replies referring to the control and
                   *       data connections.
                   *
                   * x3z   Authentication and accounting - Replies for the login
                   *       process and accounting procedures.
                   *
                   * x4z   Unspecified as yet.
                   *
                   * x5z   File system - These replies indicate the status of the
                   *       Server file system vis-a-vis the requested transfer or
                   *       other file system action.
                   **/

                    group = parseInt(code / 10) % 10; // second digit
                    switch(group) {
                        case 0:
                            if (code === 200)
                                _self.$executeNext();
                            else
                                _self.$executeNext(makeError(code, text));
                            break;
                        case 1:
                            if (code >= 211 && code <= 215)
                                _self.$executeNext(text);
                            else
                                _self.$executeNext(makeError(code, text));
                            break;
                        case 2:
                            if (code === 226) { /** closing data connection, file action request successful */
                                _self.$executeNext();
                            }
                            else if (code === 227) {
                                /** server entering passive mode */
                                var parsed = text.match(/([\d]+),([\d]+),([\d]+),([\d]+),([-\d]+),([-\d]+)/);

                                if (!parsed)
                                    throw new Error("Could not parse passive mode response: " + text);

                                _self.$pasvIP = parsed[1] + "." + parsed[2] + "." + parsed[3] + "." + parsed[4];
                                _self.$pasvPort = (parseInt(parsed[5]) * 256) + parseInt(parsed[6]);
                                /** call $executeNext after having dataSocket connected, then wait for response */
                                return _self.$pasvConnect();
                            }
                            else {
                                _self.$executeNext(makeError(code, text));
                            }
                            break;
                        case 3:
                            if (code === 331 || code === 230)
                                _self.$executeNext(code === 331);
                            else
                                _self.$executeNext(makeError(code, text));

                            break;
                        case 5: /** server file system state */
                            if (code === 250 &&
                                _self.$queue.length &&
                                _self.$queue[0][0] === "MLST") {
                                _self.$executeNext(text);
                            }
                            else if (code === 250 || code === 350) {
                                _self.$executeNext();
                            }
                            else if (code === 257) {
                                var path = text.match(/(?:^|\s)\"(.*)\"(?:$|\s)/);
                                if (path)
                                    path = path[1].replace(/\"\"/g, '"');
                                else
                                    path = text;
                                _self.$executeNext(path);
                            }
                            else
                                _self.$executeNext(makeError(code, text));
                            break;
                    }
                }
                // Run next command in the queue, if any...
                if (processNext) _self.send();
            }
        });
    };

    /**
     * Authenticates by running USER, PASS and TYPE as a sequence, then upgrades the state
     * from 'connected' to 'authorized'. This state is used throughout.
     *
     * @param {String} user name
     * @param {String} password
     * @param {Function} callback
     * @type {Boolean} true
     */
    this.auth = function(user, password, callback) {
        if (this.$state !== "connected")
            return false;

        if (_.isFunction(user)) {
            callback = user;
            user = "anonymous";
            password = "anonymous@";
        } else if (_.isFunction(password)) {
            callback = password;
            password = "anonymous@";
        }

        var cmds = [["USER", user], ["PASS", password]];
        var cur = 0;
        var _self = this;
        var next = function(err, result) {
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

    /**
     * Print the current working directory name.
     *
     * @param {Function} callback
     * @type {Boolean}
     */
    this.pwd = function(callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            this.send("PWD", callback)
        }
    };

    /**
     * Makes the given directory be the current directory on the remote host.
     *
     * @param {String} path to which change
     * @param {Function} callback
     * @type {Boolean}
     */
    this.cwd = function(path, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            this.send("CWD", path, callback);
        }
    };

    /**
     * Copy one file from the remote machine to the local machine.
     *
     * @param {String} path to which change
     * @param {Function} callback
     * @type {Boolean}
     */
    this.get = function(path, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            var _self = this;
            return this.send("PASV", function(err, stream) {
                if (err)
                    return callback(err);

                _self.$changeToPath(path, function(path, node) {
                    var buffers = [];

                    stream.on("data", function(buffer) {
                        buffers.push(buffer);
                    });

                    stream.on("end", function() {
                        callback(null, Utils.concatBuffers(buffers));
                    });

                    var result = _self.send("RETR", node, function(err) {
                        if (err)
                            return callback(err);
                    });

                    if (!result)
                        callback(new Error("Connection severed"));
                });
            });
        }
    };

    /**
     * Copy one file from the local machine to the remote machine.
     *
     * @param {Object} buffer containing the data to be sent
     * @param {String} destination path
     * @param {Function} callback
     * @param {Boolean} execute append instead of put
     * @type {Boolean}
     */
    this.put = function(buffer, destpath, callback, append) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
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
        }
    };

    /**
     * Append contents to the end of a specific file.
     *
     * @param {Object} buffer containing the data to be sent
     * @param {String} destination path
     * @param {Function} callback
     */
    this.append = function(buffer, destpath, callback) {
        this.put(buffer, destpath, callback, true);
    };

    /**
     * Copy remote location to another remote location (not implemented).
     */
    this.copy = function(origpath, destpath, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else
            //@todo dir copy involves deep recursive copying
            callback();
    };

    /**
     * Delete (remove) a file in the current remote directory (same as rm in UNIX)
     *
     * @param {String} path of file
     * @param {Function} callback
     */

    this["delete"] = function(path, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            var _self = this;
            this.$changeToPath(path, function(path, node) {
                _self.send("DELE", node, callback);
            });
        }
    };

    /**
     * Rename a node; RNFR followed by an RNTO command to specify the new name.
     *
     * @param {String} path for RNFR
     * @param {String} path to RNTO
     * @param {Function} callback
     */
    this.rename = function(pathFrom, pathTo, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            var _self = this;
            var ret;
            this.$changeToPath(pathFrom, function(path, node) {
                _self.send("RNFR", node, function(err) {
                    if (err)
                        return callback(err);

                    node = pathTo.split("/").pop().replace(/\/+$/, "");
                    if (!_self.send("RNTO", node, callback))
                        callback(new Error("Connection severed"));
                });
            });
        }
    };

    /**
     * Creates the named directory on the remote host.
     *
     * @param {String} path of new directory
     * @param {Function} callback
     */
    this.mkdir = function(path, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            var _self = this;
            this.$changeToPath(path, function(path, node) {
                _self.send("MKD", node, callback);
            });
        }
    };

    /**
     * Deletes the named directory on the remote host.
     *
     * @param {String} path of directory to delete
     * @param {Function} callback
     */
    this.rmdir = function(path, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            var _self = this;
            this.$changeToPath(path, function(path, node) {
                _self.send("RMD", node, callback);
            });
        }
    };

    /**
     * Forward method to read a directory listing and return an array of nodes.
     *
     * @param {String} path of directory
     * @param {Function} callback
     */
    this.readdir = function(path, callback) {
        if (debug) debug("READ DIR " + path);
        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.list(EMPTY_PATH, function(err, emitter) {
                if (err)
                    return callback(err);

                var nodes = [];
                emitter.on("entry", function(entry) {
                    nodes.push(new Stat(entry));
                });

                emitter.on("error", function(err) {
                    _self.$socket.end();
                    callback("Error during LIST(): " + Util.inspect(err));
                });

                emitter.on("success", function() {
                    callback(null, nodes);
                });
            });
        }, true);
    };

    /**
     * Gives the current stat of a node specified in path. Returns a single struct object.
     *
     * @param {String} path of node
     * @param {Function} callback
     */
    this.stat = this.lstat = this.fstat = function(path, callback) {
        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.list(EMPTY_PATH, function(err, emitter) {
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

    /**
     * Syntax: LIST [remote-filespec]
     * If remote-filespec refers to a file, sends information about that file. If remote-filespec refers to a directory,
     * sends information about each file in that directory. remote-filespec defaults to the current directory.
     * This command must be preceded by a PORT or PASV command.
     *
     * @param {String} path of node
     * @param {Function} callback
     */
    this.list = function(path, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            if (_.isFunction(path)) {
                callback = path;
                path = null;
            }

            var _self = this;
            var emitter = new EventEmitter();
            var params;

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

                    var result;
                    var cbTemp = function(err) {
                        if (err)
                            return emitter.emit("error", err);
                        emitter.emit("success");
                    };

                    if (path)
                        result = _self.send("LIST", path, cbTemp);
                    else
                        result = _self.send("LIST", cbTemp);

                    if (result)
                        callback(null, emitter);
                    else
                        callback(new Error("Connection severed"));
                });
            //}
        }
    };

    /**
     * EXTENDED Ftp FEATURES: SYST, STAT, CHMOD, SIZE, MDTM, IDLE, NOOP
     */

    /**
     * Returns a word identifying the system, the word "Type:", and the default
     * transfer type (as would be set by the TYPE command). For example: UNIX Type: L8
     *
     * @param {Function} callback
     */
    this.system = function(callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            this.send("SYST", callback);
        }
    };

    /**
     * Returns general status information about the Ftp server process.
     *
     * @param {Function} callback
     */
    this.status = function(callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            this.send("STAT", callback);
        }
    };

    /**
     * Changes file permissions to the specified mode as Octal, same as Unix.
     *
     * @param {String} path to which change permissions
     * @param {Number} octal version of permissions, e.g. '755'
     * @param {Function} callback
     */
    this.chmod = function(path, mode, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else {
            var _self = this;
            this.$changeToPath(path, function(path, node) {
                _self.send("SITE CHMOD", [mode, node].join(" "), callback);
            });
        }
    };

    /**
     * Returns the file size in bytes.
     *
     * @param {String} path of file
     * @param {Function} callback
     */
    this.size = function(path, callback) {
        if (this.$state !== "authorized") {
            callback(new Error("Unauthorized"));
        }
        else if (!this.$feat["SIZE"]) {
            callback(new Error("This server doesn't support the SIZE command"));
        }
        else {
            var _self = this;
            this.$changeToPath(path, function(path, node) {
                _self.send("SIZE", node, callback);
            });
        }
    };

    /**
     * Returns the last modification in a GMT Date object
     *
     * About the MTMD time value:
     * ==========================
     * The syntax of a time value is:
     * time-val       = 14DIGIT [ "." 1*DIGIT ]
     * The leading, mandatory, fourteen digits are to be interpreted as, in
     * order from the leftmost, four digits giving the year, with a range of
     * 1000--9999, two digits giving the month of the year, with a range of
     * 01--12, two digits giving the day of the month, with a range of
     * 01--31, two digits giving the hour of the day, with a range of
     * 00--23, two digits giving minutes past the hour, with a range of
     * 00--59, and finally, two digits giving seconds past the minute, with
     * a range of 00--60 (with 60 being used only at a leap second).  Years
     * in the tenth century, and earlier, cannot be expressed.  This is not
     * considered a serious defect of the protocol.
     *
     * The optional digits, which are preceded by a period, give decimal
     * fractions of a second.  These may be given to whatever precision is
     * appropriate to the circumstance, however implementations MUST NOT add
     * precision to time-vals where that precision does not exist in the
     * underlying value being transmitted.
     *
     * Symbolically, a time-val may be viewed as
     *    YYYYMMDDHHMMSS.sss
     * The "." and subsequent digits ("sss") are optional.  However the "."
     * MUST NOT appear unless at least one following digit also appears.
     * Time values are always represented in UTC (GMT), and in the Gregorian
     * calendar regardless of what calendar may have been in use at the date
     * and time indicated at the location of the server-PI.
     *
     * The technical differences among GMT, TAI, UTC, UT1, UT2, etc., are
     * not considered here.  A server-Ftp process should always use the same
     * time reference, so the times it returns will be consistent.  Clients
     * are not expected to be time synchronized with the server, so the
     * possible difference in times that might be reported by the different
     * time standards is not considered important.
     *
     * Any fractions of second re discarded in this implementation.
     *
     * @param {String} path of node
     * @param {Function} callback
     * @returns {Date} JavaScript Date object in GMT
     */
    var RE_MDTM_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:.\d+)?$/;
    this.lastMod = function(path, callback) {
        if (this.$state !== "authorized" || !this.$feat["MDTM"])
            return callback(new Error("Not implemented"));

        var _self = this;
        this.$changeToPath(path, function(path, node) {
            _self.send("MDTM", node, function(err, text) {
                if (err)
                    return callback(err);

                if (!RE_MDTM_TIME.test(text)) {
                    return callback(
                        new Error("Invalid date/time format from server"));
                }

                callback(null, new Date(
                    text.replace(RE_MDTM_TIME, "$1-$2-$3 $4:$5:$6 GMT")));
            });
        });
    };
    
    this.idle = function(secs, callback) {
        if (this.$state !== "authorized" || !this.$feat["IDLE"])
            return callback(new Error("Not implemented"));
        
        secs = secs || this.idleSeconds;
        var _self = this;
        this.send("SITE IDLE", secs, function(err) {
            if (!err) _self.idleSeconds = secs;
            callback(err, _self.idleSeconds);
        });
    };
    
    /**
     * Does nothing except return a response. Used to keep connection alive and avoid innactivity timeout.
     * Sidenotes:
     * Only successful transfer commands (APPE, STOR, RETR, Lists), NOOP command (if option is enabled) and successful delete,
     * rename commands reset the client idle time. Other commands are often ignored.
     * However, when using NOOP the server in theory should not close the control socket, but keep it alive.
     * Some server do not implement NOOP correctly, and they close the control socket, therefore we must use LIST :/
     */
    this.noop = function(callback) {
        if (this.$state !== "authorized"/* || !this.$feat["NOOP"]*/)
            return callback(new Error("Not authorized"));
        
        //this.send("NOOP", callback);
        this.list("/", callback);
    };

    /**
     * Sets the point at which a file transfer should start; useful for resuming
     * interrupted transfers. For nonstructured files, this is simply a decimal number.
     * This command must immediately precede a data transfer command (RETR or STOR only);
     * i.e. it must come after any PORT or PASV command.
     *
     * @param {Number} decimal number
     * @param {Function} callback
     * @type {Boolean}
     */
    this.restart = function(offset, callback) {
        return (this.$state !== "authorized" || !this.$feat["REST"] || !(/STREAM/i.test(this.$feat["REST"])))
            ? false
            : this.send("REST", offset, callback);
    };

    /**
     * Writes a command to control socket and adds it to the queue.
     *
     * @param {String} Ftp command
     * @param {String} parameters following the command
     * @param {Function} callback
     * @type {Boolean}
     */
    this.send = function(cmd, params, callback) {
        if (!this.$socket || !this.$socket.writable)
            return false;

        if (cmd) {
            cmd = ("" + cmd).toUpperCase();

            if (_.isFunction(params)) {
                callback = params;
                params = null;
            }
            
            if (!params || params == EMPTY_PATH)
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
            setupIdle.call(this);
        }
        
        return true;
    };

    /**
     * Sends a PASV command to initialize the data socket and prepare it
     * for transfers from a LIST command.
     *
     * @param {Object} event emitter as delegation object
     * @param {String} type of listing command used, usually LIST or MLSD
     * @param {Function} callback
     * @type {Boolean}
     */
    this.$pasvGetLines = function(emitter, type, callback) {
        return this.send("PASV", function(err, stream) {
            if (err)
                return callback(err);
            else if (!emitter)
                return emitter.emit("error", new Error("Connection severed"));
            else if (!stream || !stream.readable)
                return callback(new Error("Stream not readable"));

            var curData = "";
            var lines;
            stream.setEncoding("utf8");
            // Note: stream will start transfering by cmd 'LIST'
            stream.on("data", function(data) {
                curData += data;
                if (RE_NEWLINE.test(curData)) {
                    if (curData[curData.length-1] === "\n") {
                        lines = curData.split(RE_NEWLINE);
                        curData = "";
                    } else {
                        var pos = curData.lastIndexOf("\r\n");
                        if (pos === -1)
                            pos = curData.lastIndexOf("\n");
                        lines = curData.substring(0, pos).split(RE_NEWLINE);
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

    /**
     * Method called from the control-socket response handler. Server returned a 227 code
     * in the reply, therefore server is ready to for the data socket to start transfering.
     *
     * @type {Boolean}
     */
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

    /**
     * Executes the next callback in the stack, usually triggered by server reply.
     *
     * @param {mixed} instance of Error if the reply so indicates it, or socket stream, or even text.
     * @type {Boolean}
     */
    this.$executeNext = function(result) {
        if (!this.$queue.length)
            return false;

        var p = this.$queue.shift();
        var callback = (p.length === 3 ? p[2] : p[1]);

        if (!callback)
            return false;

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

    var Stat = function(struct) {
        this.uid    = struct.owner;
        this.gid    = struct.group;
        this.date   = struct.date;
        this.time   = struct.time;
        this.size   = struct.size;
        this.name   = struct.name;
        this.rights = struct.rights;

        /**
         * Convenience method to return the lastmod date using the Timezone difference
         * previously calculated using MDTM and LIST to approximate.
         */
        this.getLastMod = function(type) {
            var gmtDate = new Date(struct.time);

            if (!type || type === "LIST") {
                var sign  = this.TZHourDiff > 0 ? "-" : "+";
                var hours = sign + "0" + Math.abs(this.TZHourDiff) + "00";

                return new Date(gmtDate.toString() + " " + hours);
            }
            else if (type === "MLSD")
                return new Date(time);
        };

        var types = Parser.nodeTypes;
        this.isFile = function() {
            return struct.type === types.FILE_TYPE;
        };

        this.isDirectory = function() {
            return struct.type === types.DIRECTORY_TYPE;
        };

        this.isBlockDevice = function() {
            return struct.type === types.UNKNOWN_TYPE;
        };

        this.isCharacterDevice = function() {
            return struct.type === types.UNKNOWN_TYPE;
        };

        this.isSymbolicLink = function() {
            return struct.type === types.UNKNOWN_TYPE;
        };

        this.isFIFO = function() {
            return struct.type === types.UNKNOWN_TYPE;
        };

        this.isSocket = function() {
            return struct.type === types.UNKNOWN_TYPE;
        };
    };
}).call(Ftp.prototype);

var Utils = {
    concatBuffers: function(bufs) {
        var buffer;
        var length = 0;
        var index  = 0;

        if (!_.isArray(bufs))
            bufs = Array.prototype.slice.call(arguments);

        for (var i = 0, l = bufs.length; i < l; ++i) {
            buffer = bufs[i];
            if (!Buffer.isBuffer(buffer))
                buffer = bufs[i] = new Buffer(buffer);
            length += buffer.length;
        }
        buffer = new Buffer(length);

        bufs.forEach(function(buf, i) {
            buf = bufs[i];
            buf.copy(buffer, index, 0, buf.length);
            index += buf.length;
            delete bufs[i];
        });

        return buffer;
    },

    /*
    Target API:

     var s = require('net').createStream(25, 'smtp.example.com');
     s.on('connect', function() {
      require('starttls')(s, options, function() {
         if (!s.authorized) {
           s.destroy();
           return;
         }

         s.end("hello world\n");
       });
     });
     */
    starttls: function(socket, options, cb) {
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
    },

    pipe: function(pair, socket) {
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
};
