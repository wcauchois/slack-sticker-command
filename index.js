var express = require('express'),
    util = require('util'),
    bodyParser = require('body-parser'),
    morgan = require('morgan'),
    request = require('request'),
    _ = require('lodash'),
    EditDistance = require('levenshtein'),
    CronJob = require('cron').CronJob,
    MongoClient = require('mongodb').MongoClient;

var app = express();

app.disable('etag'); // Don't send 304s for everything
app.use(morgan('short'));
app.use(bodyParser.urlencoded({ extended: false }));

// Map from sticker ID -> [list of aliases for that sticker]
// Loaded from mongo on startup, then updated in memory/in mongo.
var aliases = {};

app.get('/', function(req, res) {
  res.send("Nothing to see here.");
});

var defaultSize = parseInt(process.env.DEFAULT_SIZE);

app.post('/sticker', function(req, res) {
  util.log("Got: " + JSON.stringify(req.body));
  if (req.body['token'] !== process.env.SLACK_TOKEN) {
    res.status(403).send('Forbidden');
  } else {
    res.set('Content-Type', 'text/plain');
    var trimmedText = req.body.text.trim();
    if (trimmedText === 'list') {
      var buf = 'The following stickers are available:\n';
      _.each(stickers, function(s) {
        buf += '- ' + s.getName() + ' [' + s.getId() + ']\n';
      });
      res.send(buf);
    } else if (trimmedText === 'sizes') {
      // Sizes are hardcoded for now
      res.send("Available sizes: 60, 94, 150, 300\n" +
        "Type /sticker [size] [name or oid] to use a specified size.");
    } else if (trimmedText === "aliases") {
      var buf = 'The following aliases are available:\n';
      _.each(aliases, function(value, key) {
        var sticker = findStickerById(key);
        if (sticker) {
          buf += "" + sticker.getName() + ": " + value.join(', ') + "\n";
        }
      });
      buf += "(Type /sticker alias <sticker ID> <new alias> to create a new alias. Type /sticker unalias <alias> to remove an alias.)\n";
      res.send(buf);
    } else if (trimmedText.startsWith("alias")) {
      var m = trimmedText.match(/alias ([a-z0-9]+) (.*)$/);
      if (m) {
        var sticker = findStickerById(m[1]);
        if (sticker) {
          var addedAlias = addAlias(sticker.getId(), m[2]);
          res.send("Aliased " + sticker.getId() + " to \"" + addedAlias + "\"");
        } else {
          res.send("Sticker with ID " + m[1] + " not found");
        }
      } else {
        res.send("Type /sticker alias <sticker ID> <new alias>");
      }
    } else if (trimmedText.startsWith("unalias")) {
      var m = trimmedText.match(/unalias (.*)$/);
      if (m) {
        var removed = removeAlias(m[1]);
        res.send(removed ? "Removed that alias" : "No such alias to remove");
      } else {
        res.send("Type /sticker unalias <alias>");
      }
    } else if (trimmedText === 'warmup') {
      res.send("OK, Ready");
    } else {
      var name = req.body.text;
      var size = defaultSize;
      var m = name.match(/(\d+)(.*)/);
      if (m) {
        name = m[2];
        size = parseInt(m[1], 10);
      }
      var sticker = findSticker(name);
      var imageUrl = sticker.makeImageUrl(size);
      if (sticker && imageUrl) {
        sendSlack(req.body, ':thief:', null, [
          {
            'fallback': sticker.getName(),
            'color': '#ffa633',
            'image_url': imageUrl
          }
        ], function(err) {
          if (err) {
            res.send(err.message);
          } else {
            res.send('');
          }
        });
      } else {
        res.send("Couldn't find that sticker or image at that size");
      }
    }
  }
});

function sendSlack(params, emoji, text, attachments, cb) {
  var payload = {'username': params['user_name'], 'icon_emoji': emoji, 'channel': params['channel_id']};
  if (text) payload['text'] = text;
  if (attachments) payload['attachments'] = attachments;
  request({
    url: process.env.WEBHOOK_URL,
    form: {'payload': JSON.stringify(payload)},
    method: 'POST'
  }, function(err, response, body) {
    if (err || response.statusCode !== 200) {
      var newErr = new Error("Error posting to Slack: " + ((err && err.message) ||
        ("Got code " + response.statusCode)) + "\n\n" + body);
      util.log(newErr.message);
      cb && cb(newErr);
    } else {
      cb(null);
    }
  });
}

var stickers = [];

function buildClientVersion() {
  var d = new Date();
  var buf = '';
  buf += d.getFullYear();
  var realMonth = d.getMonth() + 1;
  buf += (realMonth < 10) ? ('0' + realMonth) : realMonth;
  buf += (d.getDate() < 10) ? ('0' + d.getDate()) : d.getDate();
  return buf;
}

function Sticker() {
  this.initialize.apply(this, arguments);
}
_.extend(Sticker.prototype, {
  initialize: function(json) {
    this.json = json;
  },

  isValid: function() {
    return (typeof this.json.name !== 'undefined' && !this.json.restricted);
  },

  getName: function() {
    return this.json.name;
  },

  getLCaseName: function() {
    return this.getName().toLowerCase();
  },

  getId: function() {
    return this.json.id;
  },
  
  makeImageUrl: function(size) {
    if (
      this.json.image && this.json.image.prefix && this.json.image.name &&
      _.includes(this.json.image.sizes || [], size)
    ) {
      return this.json.image.prefix + size + this.json.image.name;
    }
  }
});

function refreshStickers() {
  util.log("Loading stickers");
  request({
    url: 'https://api.foursquare.com/v2/stickers/all',
    qs: {
      'oauth_token': process.env.FOURSQUARE_TOKEN,
      'v': buildClientVersion(),
      'm': 'swarm'
    }
  }, function(err, response, body) {
    if (err || response.statusCode !== 200) {
      util.log("Error fetching stickers: " + ((err && err.message) ||
        ("Got code " + response.statusCode)));
    } else {
      var json = JSON.parse(body);
      stickers = [];
      if (json.response && json.response.stickers) {
        stickers = _.chain(json.response.stickers)
          .map(function(s) { return new Sticker(s); })
          .filter(function(s) { return s.isValid(); })
          .value();
      }
      util.log('Got ' + stickers.length + ' stickers!');
    }
  });
}

var oidRegex = /^[0-9a-fA-F]{24}$/;

function findStickerById(id) {
  return _.find(stickers, function(s) { return s.getId() === id; });
}

function findSticker(name) {
  name = name.trim().toLowerCase();
  if (oidRegex.test(name)) {
    return findStickerById(name);
  } else {
    var aliasMatch;
    _.each(aliases, function(value, key) {
      if (value.indexOf(name) >= 0) {
        aliasMatch = findStickerById(key);
        return false;
      }
    });
    if (aliasMatch) {
      return aliasMatch;
    } else {
      return _.chain(stickers)
        .sortBy(function(s) { return new EditDistance(s.getLCaseName(), name).distance; })
        .first()
        .value();
    }
  }
}

refreshStickers();

var job = new CronJob(process.env.STICKER_REFRESH_INTERVAL, function() {
  refreshStickers();
});
job.start();

var aliasesMongoId = "56e0832ee4b0d99a76088c4d";
var aliasesCollection;

function sanitizeAlias(theAlias) {
  return theAlias.trim().toLowerCase().substring(0, 80);
}

function maybeUpdateAliases() {
  if (aliasesCollection) {
    aliasesCollection.replaceOne({_id: aliasesMongoId}, aliases, {upsert: true});
  } else {
    util.log("Warning: aliases not getting persisted, no MongoDB");
  }
}

function addAlias(id, newAlias) {
  newAlias = sanitizeAlias(newAlias);
  aliases[id] = _.uniq([newAlias].concat(aliases[id] || []));
  maybeUpdateAliases();
  return newAlias;
}

function removeAlias(theAlias) {
  theAlias = sanitizeAlias(theAlias);
  var key = _.find(aliases, function(value, key) { return value.indexOf(theAlias) >= 0; });
  var newValue = _.filter(aliases[key], function(x) { return x !== theAlias; });
  var removed = newValue.length !== aliases[key].length;
  if (newValue.length) {
    aliases[key] = newValue;
  } else {
    delete aliases[key];
  }
  maybeUpdateAliases();
  return removed;
}

if (require.main === module) {
  if (process.env.MONGOLAB_URI) {
    MongoClient.connect(process.env.MONGOLAB_URI, function(err, db) {
      if (err) {
        util.log("Error connecting to Mongo: " + err.message);
      } else {
        aliasesCollection = db.collection('aliases');
        aliasesCollection.find({_id: aliasesMongoId}).toArray(function(err, docs) {
          if (!err && docs.length) {
            aliases = docs[0];
            util.log("Loaded aliases: " + JSON.stringify(aliases));
          } else {
            util.log("No saved aliases found");
          }
        });
      }
    });
  } else {
    util.log("No Mongo specified, aliases won't be persisted");
  }

  var port = process.env['PORT'] || 3000;
  app.listen(port, function() {
    util.log('Started on port ' + port);
  });
}

