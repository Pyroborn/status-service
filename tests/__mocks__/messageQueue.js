module.exports = {
    init: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(true),
    publishStatusCreated: jest.fn().mockResolvedValue(true),
    publishStatusUpdated: jest.fn().mockResolvedValue(true),
    url: 'amqp://localhost:5672',
    exchangeName: 'status_events'
}; 