
var net = require('net');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var uuid = require('node-uuid'); // we need unique IDs.

var ip = require('./common/ip'); // for discovering the external IP address
var diff = require('./common/diff'); // not used yet.
var SHash = require('./common/SHash'); // A special collection type
var BallotBox = require('./common/BallotBox'); // for voting

var timers = {};

var dataStore = SHash();
var ballotbox = BallotBox();

var clearTimers = function() { // on exit, kill all timers.

  for(var timer in timers) {
    clearTimeout(timers[timer].timer);
    delete timers[timer];
  }
};

//
// a timer is used to keep track of how long its been 
// since we've heard from a peer. If the timer runs out
// we stop trying to broadcast to that peer by marking
// it as dead. If we hear from it again, it gets marked
// as alive.
//
var Timer = function Timer(timeout, uuid, callback) {

  if(!(this instanceof Timer)) {
    return timers[uuid] = new Timer(timeout, uuid, callback);
  }

  this.callback = callback;
  this.timeout = timeout;
  this.uuid = uuid;
  this.timer = null;
};

Timer.prototype.start = function() {
  
  this.timer = setTimeout(this.callback, this.timeout);
};

Timer.prototype.stop = function() {
  clearTimeout(this.timer);
  delete timers[this.uuid];
};

Timer.prototype.reset = function() {
  clearTimeout(this.timer);
  this.start();
};

var Vine = module.exports = function Vine(opts, callback) {

  if(!(this instanceof Vine)) {
    return new Vine(opts, callback);
  }

  EventEmitter.call(this);

  if(!arguments[1]) {
    callback = opts;
    opts = {};
  }

  var that = this;

  this.peers = opts.peers || {};
  this.defaultTimeout = opts.timeout || 1e4;

  var server = this.server = net.createServer(function(socket) {

    //
    // when we get data, decide if 
    // we are interested in it or not.
    //
    socket.on('data', function(data) {

      //
      // we pass in the socket so that 
      // we can have a conversation if
      // the need arises.
      //
      that.receive(data, socket);
    });
  });

  server.on('connection', callback || function() {});

  var id = uuid.v4();

  //
  // A data structure representing the peer's important details.
  //
  this.details = {

    uuid: id,
    address: ip.externalAddress(),
    port: opts.port || 8992,

    alive: true,
    lifetime: 0,
    timeout: this.defaultTimeout,
    heartbeatInterval: opts.heartbeatInterval || 100,
    listInterval: opts.listInterval || 300,
    hashInterval: opts.hashInterval || 300
  };

  //
  // add ourselves to the list of peers that we know about.
  //
  this.peers[id] = this.details;
};

util.inherits(Vine, EventEmitter);

//
// receive a message from a peer.
//
Vine.prototype.receive = function(msg, socket) {

  var that = this;

  try {
    msg = JSON.parse(String(msg));
  }
  catch(ex) {
    return false;
  }

  that.emit('data', msg, socket);

  if (!msg.meta && !msg.meta.type && !msg.data) {
    return false; // not a message we understand.
  }

  that.emit(msg.meta.type, msg.data, socket);

  if (msg.meta.type === 'gossip') {

    var key = msg.data[0];
    var hash = msg.data[1];
    
    if (dataStore.interest(key, hash)) {  // its new, we want it.

      socket.write({ // send a message back to the socket.
        meta: {
          type: 'request'
        },
        data: msg.data
      });
    }
    else { // we already know about this.

      //
      // we can end the conversation now. Although, to
      // comply with the gossip protocol, we should actually
      // cycle until we find something that is an update.
      //
      socket.end();
    }
  }
  else if (msg.meta.type === 'request') {

    //
    // there has been a request for a value,
    // in this case we can be sure its wanted.
    //
    var key = msg.data[0];
    var hash = msg.data[1];

    socket.write({ // send a message to the socket with the value in it.
      meta: {
        type: 'response'
      },
      data: {
        key: key,
        value: dataStore.get(key)
      }
    });
  }
  else if (msg.meta.type === 'response') {

    dataStore.setUnique(msg.data.key, msg.data.value);
    socket.end();
  }
  else if (msg.meta.type === 'votes') {

    var data = msg.data;

    //
    // first of all, does this peer care about this election?
    //
    if (ballotbox.elections[data.topic]) {

      //
      // we do care about this election, merge in the new votes.
      //
      ballotbox.merge(this.details.uuid, data.topic, data);

      if (!ballotbox.decide(this.details.uuid, data.topic)) {

        //
        // we have not yet come to a quorum, we should end this
        // socket and send the votes to another random peer.
        //
        this.send('votes', ballotbox.elections[data.topic]);
      }
      else {

        //
        // success! let the user know we have a quorum and that
        // the reults are in (the election will be closed).
        //
        this.emit(
          'quorum', 
          data.topic, 
          ballotbox.elections[data.topic],
          ballotbox.results[data.topic]
        );
      }
    }
    socket.end();
  }
  else if (msg.meta.type === 'list') { // handle merging the lists

    var peers = msg.data; // the message data is a list of peers.

    for (peerId in peers) {

      var knownPeer = that.peers[peerId]; // do we know this peer?

      if (knownPeer) {

        //
        // compare the lifetime of the peers.
        //
        if (peers[peerId].lifetime > knownPeer.lifetime) {

          if (peers[peerId].alive === false) {
            peers[peerId].alive = true; // revive this peer.
          }

          // update the peer with latest heartbeat
          knownPeer.lifetime = peers[peerId].lifetime;

          // and reset the timeout of that peer
          timers[peerId] && timers[peerId].reset();
        }
      }
      else { // this is a new peer

        // add it to the peers list
        that.peers[peerId] = peers[peerId];

        // creat a timer for this peer
        var timeout = peers[peerId].timeout || this.defaultTimeout;

        var timer = Timer(timeout, peerId, (function(peerId) {
          return function() {
            
            //
            // if we dont hear from this peer for a while,
            // stop trying to broadcast to it until we hear 
            // from it again.
            //
            that.peers[peerId].alive = false;
          }
        }(peerId)));

        timer.start();
      }
    }

    socket.end(); // we got the list, no need to have a conversation.
  }

  return this;
};

//
// send a message to a random peer.
//
Vine.prototype.send = function(type, data, port, address) {

  ++this.details.lifetime;

  var that = this;

  //
  // get a random peer, or provide one
  // 
  if (!address && !port) {

    var peer = this.randomPeer();

    if (peer === null) {
      return this;
    }

    address = peer.address;
    port = peer.port;

  }
  else if (!address) {
    address = '127.0.0.1';
  }

  var msg = {

    meta: { 
      type: type
    },
    data: data
  };

  that.emit('send', port, address, msg);

  var message = new Buffer(JSON.stringify(msg));

  var client = net.connect({
    port: port, 
    host: address 
  });

  client.on('error', function(err) {
    // do nothing
  })

  client.on('connect', function() {

    that.emit('sent', port, address, msg);
    client.write(message);
  });

  return this;
};

//
// set a local value on this peer.
//
Vine.prototype.set = function(key, val) {

  dataStore.set(key, val);
};

//
// get a local value from this peer.
//
Vine.prototype.get = function(key) {

  return dataStore.get(key);
};

//
// get a local value from this peer. voting happens
// agressively, each time a vote is cast, it sends to
// a random peer the entire contents of the ballotbox.
//
Vine.prototype.vote = function(topic, value) {

  //
  // each time a vote is cast, we can check to see if
  // we have reached a quorum, if not then send off the
  // votes that we know about to the next random peer.
  //
  var result = ballotbox.vote(this.details.uuid, topic, value);

  if (result.closed) {

    var event = result.expired ? 'deadline' : 'quorum';

    return this.emit(
      event,
      topic,
      ballotbox.elections[topic]
    );
  }
  else {

    return this.send('votes', ballotbox.elections[topic]);
  }
};

Vine.prototype.election = function(opts) {

  //
  // track the peer creating the election, it
  // will become the election manager peer.
  //
  opts.origin = this.details.uuid;

  ballotbox.election(opts);
  return this;
};

//
// listen for messages from other peers.
//
Vine.prototype.listen = function(port, address) {

  var that = this;

  if (port) {
    that.details.port = port;
  }

  that.server.listen(that.details.port, address, function() {

    //
    // we want to send of the list at an interval.
    //
    that.listInterval = setInterval(function() {
      that.send('list', that.peers);
    }, that.details.listInterval);

    //
    // we want to send off a random pair at an interval.
    //
    that.hashInterval = setInterval(function() {
      that.send('gossip', dataStore.randomPair());
    }, that.details.hashInterval);

    //
    // we want to measure our lifetime.
    //
    that.heartbeatInterval = setInterval(function() {
      ++that.details.lifetime;
    }, that.details.heartbeatInterval);
  });

  return this;
};

//
// be done.
//
Vine.prototype.clear = function() {
  clearInterval(this.heartbeatInterval);
  clearInterval(this.listInterval);
  clearInterval(this.hashInterval);

  clearTimers();

};
Vine.prototype.close = function() {

  this.clear();
  this.server.close();

  return this;
};

//
// join an existing peer by sending the list of known peers.
//
Vine.prototype.join = function(port, address) {
  this.send('list', this.peers, port, address);
  return this;
};

//
// get a random peer from the list of known peers.
//
Vine.prototype.randomPeer = function() {

  var keys = Object.keys(this.peers);

  for (var i = 0, attempts = 10; i < attempts; i++) {

    var index = Math.floor(Math.random() * keys.length);
    var key = keys[index];

    var peer = this.peers[key];

    var isAlive = peer.alive;
    var isDifferent = (key !== this.details.uuid);

    if (isDifferent && isAlive) {
      return peer;
    }
  }

  return null;
};
