const mongoose = require('mongoose');
const { TicketStatus, STATUS_TYPES } = require('../../src/models/status');
const statusController = require('../../src/controllers/statusController');
const messageQueue = require('../../src/messageQueue');

// Mock dependencies
jest.mock('../../src/messageQueue', () => ({
    publishStatusCreated: jest.fn().mockResolvedValue(true),
    publishStatusUpdated: jest.fn().mockResolvedValue(true),
    publishStatusDeleted: jest.fn().mockResolvedValue(true),
    init: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../src/models/status', () => {
    const mockStatusTypes = {
        OPEN: 'open',
        IN_PROGRESS: 'in_progress',
        RESOLVED: 'resolved',
        CLOSED: 'closed'
    };

    const mockTicketStatus = jest.fn().mockImplementation((data) => {
        const instance = {
            ...data,
            save: jest.fn().mockResolvedValue(data),
            isValidTransition: jest.fn().mockImplementation((newStatus) => {
                const validTransitions = {
                    [mockStatusTypes.OPEN]: [mockStatusTypes.IN_PROGRESS, mockStatusTypes.CLOSED],
                    [mockStatusTypes.IN_PROGRESS]: [mockStatusTypes.RESOLVED, mockStatusTypes.CLOSED],
                    [mockStatusTypes.RESOLVED]: [mockStatusTypes.CLOSED, mockStatusTypes.IN_PROGRESS],
                    [mockStatusTypes.CLOSED]: []
                };
                return validTransitions[instance.currentStatus]?.includes(newStatus) || false;
            }),
            updateStatus: jest.fn().mockImplementation(async function(newStatus, updatedBy, reason) {
                if (!this.isValidTransition(newStatus)) {
                    throw new Error(`Invalid status transition from ${this.currentStatus} to ${newStatus}`);
                }
                // Only update if transition is valid
                this.history.push({
                    status: newStatus,
                    updatedBy,
                    reason: reason || `Status changed from ${this.currentStatus} to ${newStatus}`,
                    timestamp: new Date()
                });
                this.currentStatus = newStatus;
                return this;
            })
        };
        return instance;
    });

    mockTicketStatus.findOne = jest.fn();
    mockTicketStatus.getStatusHistory = jest.fn();

    return {
        TicketStatus: mockTicketStatus,
        STATUS_TYPES: mockStatusTypes
    };
});

describe('Status Controller', () => {
    const ticketId = 'mock-object-id';
    const validStatus = {
        ticketId,
        currentStatus: STATUS_TYPES.OPEN,
        updatedBy: 'user123'
    };

    let req;
    let res;
    let mockStatus;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();

        // Create a mock status instance
        mockStatus = new TicketStatus(validStatus);
        
        // Set up default mock returns
        TicketStatus.findOne.mockResolvedValue(mockStatus);

        // Mock request and response
        req = {
            body: {},
            params: {},
            query: {}
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };
    });

    describe('createStatus', () => {
        it('should create a new status', async () => {
            req.body = validStatus;
            await statusController.createStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                ticketId: validStatus.ticketId,
                currentStatus: validStatus.currentStatus
            }));
        });

        it('should return 400 for invalid status', async () => {
            req.body = {
                ...validStatus,
                currentStatus: 'invalid_status'
            };

            await statusController.createStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(messageQueue.publishStatusCreated).not.toHaveBeenCalled();
        });

        it('should return 400 for missing required fields', async () => {
            req.body = {};
            await statusController.createStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(messageQueue.publishStatusCreated).not.toHaveBeenCalled();
        });
    });

    describe('getStatus', () => {
        it('should return status for valid ticketId', async () => {
            req.params.ticketId = ticketId;
            await statusController.getStatus(req, res);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                ticketId: validStatus.ticketId,
                currentStatus: validStatus.currentStatus
            }));
        });

        it('should return 404 for non-existent ticketId', async () => {
            TicketStatus.findOne.mockResolvedValue(null);
            
            req.params.ticketId = ticketId;
            await statusController.getStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });

        it('should return 404 for invalid ticketId format', async () => {
            mongoose.isValidObjectId.mockReturnValueOnce(false);
            
            req.params.ticketId = 'invalid-id';
            await statusController.getStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('updateStatus', () => {
        const updateData = {
            status: STATUS_TYPES.IN_PROGRESS,
            updatedBy: 'user456',
            reason: 'Testing update'
        };

        it('should update status for valid transition', async () => {
            req.params.ticketId = ticketId;
            req.body = updateData;

            // Mock the update to succeed
            mockStatus.updateStatus.mockResolvedValueOnce({
                ...mockStatus,
                currentStatus: STATUS_TYPES.IN_PROGRESS,
                history: [
                    ...mockStatus.history,
                    { 
                        status: STATUS_TYPES.IN_PROGRESS, 
                        updatedBy: updateData.updatedBy,
                        reason: updateData.reason,
                        timestamp: new Date()
                    }
                ]
            });

            await statusController.updateStatus(req, res);

            expect(mockStatus.updateStatus).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                currentStatus: STATUS_TYPES.IN_PROGRESS
            }));
        });

        it('should create new status if ticket not found', async () => {
            TicketStatus.findOne.mockResolvedValueOnce(null);
            
            req.params.ticketId = ticketId;
            req.body = updateData;
            
            await statusController.updateStatus(req, res);
            
            expect(res.status).not.toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalled();
        });
    });

    describe('getStatusHistory', () => {
        it('should return status history', async () => {
            req.params.ticketId = ticketId;
            req.query = { limit: 10 };
            
            await statusController.getStatusHistory(req, res);
            
            expect(res.json).toHaveBeenCalledWith(expect.any(Array));
        });
    });

    describe('Event Handlers', () => {
        const ticketData = {
            id: ticketId,
            title: 'Test Ticket',
            status: 'open',
            updatedBy: 'user123'
        };

        it('should handle ticket created event', async () => {
            TicketStatus.findOne.mockResolvedValueOnce(null);
            
            await statusController.handleTicketCreated(ticketData);
            
            // Verify a new status was created
            expect(messageQueue.publishStatusCreated).toHaveBeenCalled();
        });

        it('should handle ticket assigned event', async () => {
            const assignData = {
                ...ticketData,
                assignee: 'user456'
            };
            
            await statusController.handleTicketAssigned(assignData);
            
            // Verify status was transitioned to in-progress
            expect(messageQueue.publishStatusUpdated).toHaveBeenCalled();
        });
    });
}); 