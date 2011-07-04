/*
 * @package node-ftp
 * @subpackage node-ftp
 * @copyright Copyright(c) 2011 Ajax.org B.V. <info AT ajax DOT org>
 * @author Luis Merino <mail AT luismerino DOT name>
 * @contributor Sergi Mansilla <sergi AT ajax DOT org>
 *
 * See RFC at http://www.w3.org/Protocols/rfc959
 */
var _ = require("./support/underscore");
var reKV = /(.+?)=(.+?);/;

var RE_SERVER_RESPONSE = /^(\d\d\d)(.*)/;

/**
 * this is the regular expression used by Unix Parsers.
 *
 * Permissions:
 *    r   the file is readable
 *    w   the file is writable
 *    x   the file is executable
 *    -   the indicated permission is not granted
 *    L   mandatory locking occurs during access (the set-group-ID bit is
 *        on and the group execution bit is off)
 *    s   the set-user-ID or set-group-ID bit is on, and the corresponding
 *        user or group execution bit is also on
 *    S   undefined bit-state (the set-user-ID bit is on and the user
 *        execution bit is off)
 *    t   the 1000 (octal) bit, or sticky bit, is on [see chmod(1)], and
 *        execution is on
 *    T   the 1000 bit is turned on, and execution is off (undefined bit-
 *        state)
 */

var RE_UnixEntry = new RegExp(
    "([bcdlfmpSs-])"
    + "(((r|-)(w|-)([xsStTL-]))((r|-)(w|-)([xsStTL-]))((r|-)(w|-)([xsStTL-])))\\+?\\s+"
    + "(\\d+)\\s+"
    + "(\\S+)\\s+"
    + "(?:(\\S+)\\s+)?"
    + "(\\d+)\\s+"

    //numeric or standard format date
    + "((?:\\d+[-/]\\d+[-/]\\d+)|(?:\\S+\\s+\\S+))\\s+"

    // year (for non-recent standard format)
    // or time (for numeric or recent standard format)
    + "(\\d+(?::\\d+)?)\\s+"

    //+ "(\\S*)(\\s*.*)"
    + "(.*)"
);

var RE_NTEntry = new RegExp(
    "(\\S+)\\s+(\\S+)\\s+"
    + "(<DIR>)?\\s*"
    + "([0-9]+)?\\s+"
    + "(\\S.*)"
);

var RE_VMSEntry = new RegExp(
    "(.*;[0-9]+)\\s*"
    + "(\\d+)/\\d+\\s*"
    + "(\\S+)\\s+(\\S+)\\s+"
    + "\\[(([0-9$A-Za-z_]+)|([0-9$A-Za-z_]+),([0-9$a-zA-Z_]+))\\]?\\s*"
    + "\\([a-zA-Z]*,[a-zA-Z]*,[a-zA-Z]*,[a-zA-Z]*\\)"
);


var MONTHS = [null, "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

var FILE_TYPE           = 0;
var DIRECTORY_TYPE      = 1;
var SYMBOLIC_LINK_TYPE  = 2;
var UNKNOWN_TYPE        = 3;

var READ_PERMISSION     = 0;
var WRITE_PERMISSION    = 1;
var EXECUTE_PERMISSION  = 2;

var USER_ACCESS         = 0;
var GROUP_ACCESS        = 1;
var WORLD_ACCESS        = 2;

exports.parseResponses = function(lines) {
    if (!_.isArray(lines))
        throw new TypeError("The parameter should be an Array");

    var responses = [];

    lines
        .map(function(line) {
            var match = line.match(RE_SERVER_RESPONSE);
            match && (line = [parseInt(match[1], 10), match[2]]);
            return line;
        })
        .reduce(function(p, c, i) {
            // If there is a previous line it means that we are inside a multiline
            // server response command, in which case we will add the current
            // line contents to the previous one, but we have to check if the
            // current line is the one that terminates the multiline string, in
            // which case we add its contents and terminate the multiline by
            // returning null.
            if (p) {
                var cIsMultiLine, currentMsg;
                var cIsArray = _.isArray(c);

                if (cIsArray) {
                    cIsMultiLine = c[1][0] == "-";
                    currentMsg   = c[0] + c[1];
                }
                else {
                    cIsMultiLine = false;
                    currentMsg = c;
                }

                p[1] += "\n" + currentMsg;
                // If the current line is a code/message response, and the code
                // is the same as the previous code and the current line is not
                // a multiline one (in which case it would be treated as any
                // random text).
                if (cIsArray && c[0] == p[0] && !cIsMultiLine) {
                    responses.push(p);
                    return null;
                }
                return p;
            }
            else if (c[1][0] == "-") {
                return c;
            }
            else {
                responses.push(c);
                return null;
            }
        }, null);

    return responses;
};

exports.processDirLines = function(lines, type) {
    var results = [];
    for (var i=0,result,len=lines.length; i<len; ++i) {
        if (lines[i].length) {
            if (type === 'LIST')
                result = parseList(lines[i]);
            else if (type === 'MLSD')
                result = parseMList(lines[i], numFields);

            results.push([(typeof result === 'string' ? 'raw' : 'entry'), result, lines[i]]);
        }
    }
    return results;
};

exports.getGroup = function(code) {
    return parseInt(code / 10) % 10;
};

exports.entryParser = function(entry) {
    var target, writePerm, readPerm, execPerm;
    var group = entry.match(RE_UnixEntry);

    if (group) {
        var type = group[1];
        var hardLinks = group[15];
        var usr = group[16];
        var grp = group[17];
        var size = group[18];
        var date = new Date(group[19] + " " + group[20]).getTime();
        var name = group[21];
        var endtoken = group[22];
    }

    var pos = name.indexOf(' -> ');
    if (pos > -1) {
        name   = name.substring(0, pos);
        target = name.substring(pos + 4);
    }

    switch (type[0]) {
        case 'd':
            type = DIRECTORY_TYPE;
            break;
        case 'l':
            type = SYMBOLIC_LINK_TYPE;
            break;
        case 'b':
        case 'c':
            // break; - fall through
        case 'f':
        case '-':
            type = FILE_TYPE;
            break;
        default:
            type = UNKNOWN_TYPE;
    }

    var file = {
        name: name,
        type: type,
        time: date,
        size: size,
        owner: usr,
        group: grp
    };

    if (target) file.target = target;

    var g = 4;
    ["user", "group", "other"].forEach(function(access) {
        // Use != '-' to avoid having to check for suid and sticky bits
        readPerm  = group[g] !== "-";
        writePerm = group[g + 1] !== "-";

        var execPermStr = group[g + 2];
        execPerm = (execPermStr !== "-") && !(/[A-Z]/.test(execPermStr[0]));

        file[access + "Permissions"] = {
            read : readPerm,
            write: writePerm,
            exec : execPerm
        };

        g +=4;
    });

    return file;
}

function parseMList(line) {
    var ret, result = line.trim().split(reKV);

    if (result && result.length > 0) {
        ret = {};
        if (result.length === 1)
            ret.name = result[0].trim();
        else {
            var i = 1;
            for (var k,v,len=result.length; i<len; i+=3) {
                k = result[i];
                v = result[i+1];
                ret[k] = v;
            }
            ret.name = result[result.length-1].trim();
        }
    } else
        ret = line;

    return ret;
}

