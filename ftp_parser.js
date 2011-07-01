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
var XRegExp = require('./xregexp');
var reXListUnix = XRegExp.cache('^(?<type>[\\-ld])(?<permission>([\\-r][\\-w][\\-xs]){3})\\s+(?<inodes>\\d+)\\s+(?<owner>\\w+)\\s+(?<group>\\w+)\\s+(?<size>\\d+)\\s+(?<timestamp>((?<month1>\\w{3})\\s+(?<date1>\\d{1,2})\\s+(?<hour>\\d{1,2}):(?<minute>\\d{2}))|((?<month2>\\w{3})\\s+(?<date2>\\d{1,2})\\s+(?<year>\\d{4})))\\s+(?<name>.+)$');
var reXListMSDOS = XRegExp.cache('^(?<month>\\d{2})(?:\\-|\\/)(?<date>\\d{2})(?:\\-|\\/)(?<year>\\d{2,4})\\s+(?<hour>\\d{2}):(?<minute>\\d{2})\\s{0,1}(?<ampm>[AaMmPp]{1,2})\\s+(?:(?<size>\\d+)|(?<isdir>\\<DIR\\>))\\s+(?<name>.+)$');
var reXTimeval = XRegExp.cache('^(?<year>\\d{4})(?<month>\\d{2})(?<date>\\d{2})(?<hour>\\d{2})(?<minute>\\d{2})(?<second>\\d+)$');
var reKV = /(.+?)=(.+?);/;
var RE_SERVER_RESPONSE = /^(\d\d\d)(.*)/;

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
            else if (c[1][0] == "-")
                return c;
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

function parseList(line) {
    var ret,
        info,
        thisYear = (new Date()).getFullYear(),
        months = {
            jan: 1,
            feb: 2,
            mar: 3,
            apr: 4,
            may: 5,
            jun: 6,
            jul: 7,
            aug: 8,
            sep: 9,
            oct: 10,
            nov: 11,
            dec: 12
        };

    if (ret = reXListUnix.exec(line)) {
        info = {};
        info.type = ret.type;
        info.rights = {};
        info.rights.user = ret.permission.substring(0, 3).replace('-', '');
        info.rights.group = ret.permission.substring(3, 6).replace('-', '');
        info.rights.other = ret.permission.substring(6, 9).replace('-', '');
        info.owner = ret.owner;
        info.group = ret.group;
        info.size = ret.size;
        info.date = {};
        if (typeof ret.month1 !== 'undefined') {
            info.date.month = parseInt(months[ret.month1.toLowerCase()], 10);
            info.date.date = parseInt(ret.date1, 10);
            info.date.year = thisYear;
            info.time = {};
            info.time.hour = parseInt(ret.hour, 10);
            info.time.minute = parseInt(ret.minute, 10);
        } else if (typeof ret.month2 !== 'undefined') {
            info.date.month = parseInt(months[ret.month2.toLowerCase()], 10);
            info.date.date = parseInt(ret.date2, 10);
            info.date.year = parseInt(ret.year, 10);
        }
        if (ret.type === 'l') {
            var pos = ret.name.indexOf(' -> ');
            info.name = ret.name.substring(0, pos);
            info.target = ret.name.substring(pos+4);
        } else
            info.name = ret.name;
        ret = info;
    } else if (ret = reXListMSDOS.exec(line)) {
        info = {};
        info.type = (ret.isdir ? 'd' : '-');
        info.size = (ret.isdir ? '0' : ret.size);
        info.date = {};
        info.date.month = parseInt(ret.month, 10);
        info.date.date = parseInt(ret.date, 10);
        info.date.year = parseInt(ret.year, 10);
        info.time = {};
        info.time.hour = parseInt(ret.hour, 10);
        info.time.minute = parseInt(ret.minute, 10);
        if (ret.ampm[0].toLowerCase() === 'p' && info.time.hour < 12)
            info.time.hour += 12;
        else if (ret.ampm[0].toLowerCase() === 'a' && info.time.hour === 12)
            info.time.hour = 0;
        info.name = ret.name;
        ret = info;
    } else
        ret = line; // could not parse, so at least give the end user a chance to look at the raw listing themselves

    return ret;
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

