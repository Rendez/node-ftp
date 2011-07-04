var assert = require("assert");
var async  = require("./support/async");
var Parser = require('./ftp_parser');

module.exports = {

    timeout: 500,

    setUp : function(next) {
    },

    tearDown : function(next) {
    },

    "test parseResponses function" : function(next) {
        var res1 = [
            "211 End of status",
            "123-First line",
            "Second line",
            "234 A line beginning with numbers",
            "123 The last line"
        ];

        var res2 = [
            "221-You have transferred 271165 bytes in 1 files.",
            "221-Total traffic for this session was 271859 bytes in 1 transfers.",
            "221 Thank you for using the FTP service on server.example.com."
        ];

        assert.throws(
            function() {
                Parser.parseResponses("211 End of status");
            },
            TypeError
        );

        var response = Parser.parseResponses(res1);

        assert.ok(response[0][0] === 211);
        assert.ok(response[0][1] === " End of status");

        assert.ok(response[1][0] === 123);
        assert.ok(response[1][1] ===
            "-First line\nSecond line\n234 A line beginning with numbers\n123 The last line");

        var response2 = Parser.parseResponses(res2);

        assert.ok(response2[0][0] === 221);
        assert.ok(response2[0][1] ===
            "-You have transferred 271165 bytes in 1 files.\n" +
            "221-Total traffic for this session was 271859 bytes in 1 transfers.\n" +
            "221 Thank you for using the FTP service on server.example.com.");

        next();
    },

    "test ftp LIST responses" : function(next) {
        var unixEntries = [
            {
                line: "-rw-r--r--   1 root     other     531 Jan 29 03:26 README",
                type: 0,
                size: 531,
                name: "README",
                time: 980735160000,
                owner: "root",
                group: "other",

                userReadPerm  : true,
                userWritePerm : true,
                userExecPerm  : false,

                groupReadPerm  : true,
                groupWritePerm : false,
                groupExecPerm  : false,

                otherReadPerm  : true,
                otherWritePerm : false,
                otherExecPerm  : false
            },
            {
                line: 'dr-xr-xr-x   2 root     other        512 Apr  8  2003 etc',
                type: 1,
                size: 512,
                time: 1049752800000,
                name: "etc",
                owner: "root",
                group: "other",

                userReadPerm  : true,
                userWritePerm : false,
                userExecPerm  : true,

                groupReadPerm  : true,
                groupWritePerm : false,
                groupExecPerm  : true,

                otherReadPerm  : true,
                otherWritePerm : false,
                otherExecPerm  : true
            },
            {
                line: '-rw-r--r--   1 1356107  15000      4356349 Nov 23 11:34 09 Ribbons Undone.wma',
                type: 0,
                size: 4356349,
                time: 1006511640000,
                name: "09 Ribbons Undone.wma",
                owner: "1356107",
                group: "15000",

                userReadPerm  : true,
                userWritePerm : true,
                userExecPerm  : false,

                groupReadPerm  : true,
                groupWritePerm : false,
                groupExecPerm  : false,

                otherReadPerm  : true,
                otherWritePerm : false,
                otherExecPerm  : false
            },
            {
                line: "lrwxrwxrwx   1 root     other          7 Jan 25 00:17 bin -> usr/bin",
                type: 2,
                size: 7,
                time: 980378220000,
                target: "usr/bin",
                name: "bin",
                owner: "root",
                group: "other",

                userReadPerm  : true,
                userWritePerm : true,
                userExecPerm  : true,

                groupReadPerm  : true,
                groupWritePerm : true,
                groupExecPerm  : true,

                otherReadPerm  : true,
                otherWritePerm : true,
                otherExecPerm  : true
            },
        ];

        unixEntries.forEach(function(entry) {
            var result = Parser.entryParser(entry.line);

            assert.equal(result.type, entry.type);
            assert.equal(result.size, entry.size);
            assert.equal(result.name, entry.name);
            assert.equal(result.time, entry.time);
            assert.equal(result.owner, entry.owner);
            assert.equal(result.group, entry.group);

            assert.equal(entry.userReadPerm,  result.userPermissions.read);
            assert.equal(entry.userWritePerm, result.userPermissions.write);
            assert.equal(entry.userExecPerm,  result.userPermissions.exec);

            assert.equal(entry.groupReadPerm,  result.groupPermissions.read);
            assert.equal(entry.groupWritePerm, result.groupPermissions.write);
            assert.equal(entry.groupExecPerm,  result.groupPermissions.exec);

            assert.equal(entry.otherReadPerm,  result.otherPermissions.read);
            assert.equal(entry.otherWritePerm, result.otherPermissions.write);
            assert.equal(entry.otherExecPerm,  result.otherPermissions.exec);
        });

        next();
    }
}

!module.parent && require("./support/async/lib/test").testcase(module.exports, "FTP Parser").exec();

