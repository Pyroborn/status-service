/**
 * Mock implementation of amqplib for testing
 */

// Mock channel methods
const mockChannel = {
  assertExchange: jest.fn().mockResolvedValue({}),
  assertQueue: jest.fn().mockResolvedValue({ queue: 'test-queue' }),
  bindQueue: jest.fn().mockResolvedValue({}),
  consume: jest.fn().mockResolvedValue({}),
  publish: jest.fn().mockReturnValue(true),
  sendToQueue: jest.fn().mockReturnValue(true),
  ack: jest.fn(),
  nack: jest.fn(),
  prefetch: jest.fn(),
  close: jest.fn().mockResolvedValue({})
};

// Mock connection methods
const mockConnection = {
  createChannel: jest.fn().mockResolvedValue(mockChannel),
  close: jest.fn().mockResolvedValue({}),
  on: jest.fn() // Add event handler for connection
};

// Export the mock
module.exports = {
  // Main connect method that's called by the code
  connect: jest.fn().mockResolvedValue(mockConnection),
  
  // Expose the mocks for test assertions
  mockConnection,
  mockChannel
}; 