// Define STATUS_TYPES for validation
const STATUS_TYPES = {
    OPEN: 'open',
    IN_PROGRESS: 'in_progress',
    RESOLVED: 'resolved',
    CLOSED: 'closed'
};

// Mock mongoose
jest.mock('mongoose', () => {
    class Schema {
        constructor() {
            this.methods = {};
            this.statics = {};
            this.pre = jest.fn();
        }

        // Add method to prototype
        method(name, fn) {
            this.methods[name] = fn;
        }

        // Add static to prototype
        static(name, fn) {
            this.statics[name] = fn;
        }
    }

    const mockMongoose = {
        Schema,
        model: jest.fn().mockImplementation((name, schema) => {
            // Create constructor function that includes schema methods
            function Model(data) {
                return {
                    ...data,
                    ...schema.methods,
                    save: jest.fn().mockImplementation(async function() {
                        // Validate required fields
                        if (!this.ticketId || !this.currentStatus) {
                            throw new mockMongoose.Error.ValidationError();
                        }
                        // Validate status value
                        if (!Object.values(STATUS_TYPES).includes(this.currentStatus)) {
                            throw new mockMongoose.Error.ValidationError();
                        }
                        return this;
                    }),
                    history: data.history || [{
                        status: data.currentStatus || STATUS_TYPES.OPEN,
                        updatedBy: data.updatedBy || 'system',
                        timestamp: new Date()
                    }],
                    isValidTransition: jest.fn().mockImplementation(function(newStatus) {
                        const validTransitions = {
                            [STATUS_TYPES.OPEN]: [STATUS_TYPES.IN_PROGRESS, STATUS_TYPES.CLOSED],
                            [STATUS_TYPES.IN_PROGRESS]: [STATUS_TYPES.RESOLVED, STATUS_TYPES.CLOSED],
                            [STATUS_TYPES.RESOLVED]: [STATUS_TYPES.CLOSED, STATUS_TYPES.IN_PROGRESS],
                            [STATUS_TYPES.CLOSED]: []
                        };
                        return validTransitions[this.currentStatus]?.includes(newStatus) || false;
                    }),
                    updateStatus: jest.fn().mockImplementation(async function(newStatus, updatedBy, reason) {
                        // No validation in the mock to make tests simpler
                        this.history.push({
                            status: newStatus,
                            updatedBy,
                            reason: reason || `Status changed to ${newStatus}`,
                            timestamp: new Date()
                        });
                        this.currentStatus = newStatus;
                        return this;
                    }),
                    toObject: function() { return this; }
                };
            }
            
            // Add static methods
            Model.findOne = jest.fn();
            Model.findById = jest.fn();
            Model.getStatusHistory = jest.fn();
            
            return Model;
        }),
        Types: {
            ObjectId: jest.fn(() => 'mock-object-id')
        },
        Error: {
            ValidationError: class ValidationError extends Error {
                constructor() {
                    super('Validation Error');
                    this.errors = {
                        ticketId: new Error('TicketId is required'),
                        currentStatus: new Error('CurrentStatus is required')
                    };
                }
            }
        }
    };

    // Add isValidObjectId helper
    mockMongoose.isValidObjectId = jest.fn().mockImplementation(
        (id) => /^[0-9a-fA-F]{24}$/.test(id) || id === 'mock-object-id'
    );
    
    return mockMongoose;
});

// Mock amqplib to prevent actual RabbitMQ connections
jest.mock('amqplib', () => require('./__mocks__/amqplib'));

// Mock the messageQueue
jest.mock('../src/messageQueue', () => ({
    publishStatusCreated: jest.fn().mockResolvedValue(true),
    publishStatusUpdated: jest.fn().mockResolvedValue(true),
    publishStatusDeleted: jest.fn().mockResolvedValue(true),
    channel: {},
    init: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(true)
}));

// Global test environment setup
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.SERVICE_API_KEY = 'test-service-api-key';

// Increase timeout for tests
jest.setTimeout(30000);

// Console error/warning mock to keep test output clean
global.console = {
    ...console,
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    log: jest.fn()
}; 

// Setup global afterAll to ensure all mocks are cleaned up
afterAll(() => {
    jest.restoreAllMocks();
}); 