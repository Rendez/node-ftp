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

        var response = Parser.parseResponses(res1);

        assert.ok(response[0][0] === 211);
        assert.ok(response[0][1] === " End of status");

        assert.ok(response[1][0] === 123);
        assert.ok(response[1][1] ===
            "-First line\nSecond line\n234 A line beginning with numbers\n123 The last line");

        next();
    },
}

!module.parent && require("./support/async/lib/test").testcase(module.exports, "FTP Parser").exec();

