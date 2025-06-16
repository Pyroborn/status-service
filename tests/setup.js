// Define STATUS_TYPES for validation
const STATUS_TYPES = {
    OPEN: 'open',
    IN_PROGRESS: 'in_progress',
    RESOLVED: 'resolved',
    CLOSED: 'closed'
};

// Mock mongoose implementation
jest.mock('mongoose', () => {
    class Schema {
        constructor() {
            this.methods = {};
            this.statics = {};
            this.pre = jest.fn();
        }

        // Register instance method
        method(name, fn) {
            this.methods[name] = fn;
        }

        // Register static method
        static(name, fn) {
            this.statics[name] = fn;
        }
    }

    const mockMongoose = {
        Schema,
        model: jest.fn().mockImplementation((name, schema) => {
            // Create model constructor with schema methods
            function Model(data) {
                return {
                    ...data,
                    ...schema.methods,
                    save: jest.fn().mockImplementation(async function() {
                        // Field validation
                        if (!this.ticketId || !this.currentStatus) {
                            throw new mockMongoose.Error.ValidationError();
                        }
                        // Status value validation
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
                        // Simplified for testing purposes
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
            
            // Static methods
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

    // ObjectId validation helper
    mockMongoose.isValidObjectId = jest.fn().mockImplementation(
        (id) => /^[0-9a-fA-F]{24}$/.test(id) || id === 'mock-object-id'
    );
    
    return mockMongoose;
});

// Mock RabbitMQ library
jest.mock('amqplib', () => require('./__mocks__/amqplib'));

// Mock message queue service
jest.mock('../src/messageQueue', () => ({
    publishStatusCreated: jest.fn().mockResolvedValue(true),
    publishStatusUpdated: jest.fn().mockResolvedValue(true),
    publishStatusDeleted: jest.fn().mockResolvedValue(true),
    channel: {},
    init: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(true)
}));

// Test environment configuration
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.SERVICE_API_KEY = 'test-service-api-key';

// Extended timeout for async operations
jest.setTimeout(30000);

// Suppress console output during tests
global.console = {
    ...console,
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    log: jest.fn()
}; 

// Global test cleanup
afterAll(() => {
    jest.restoreAllMocks();
}); 