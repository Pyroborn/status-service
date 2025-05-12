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
                    })
                };
            }
            // Add static methods
            Object.assign(Model, schema.statics);
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

// Mock STATUS_TYPES for validation
const STATUS_TYPES = {
    OPEN: 'open',
    IN_PROGRESS: 'in_progress',
    RESOLVED: 'resolved',
    CLOSED: 'closed'
};

// Global test environment setup
process.env.NODE_ENV = 'test';

// Console error/warning mock to keep test output clean
global.console = {
    ...console,
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
}; 