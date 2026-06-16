const EventEmitter = require('events');

const eventBus = new EventEmitter();
eventBus.setMaxListeners(30);

module.exports = eventBus;
