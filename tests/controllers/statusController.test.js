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

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();

        // Mock request and response
        req = {
            body: {},
            params: {},
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };
    });

    describe('createStatus', () => {
        it('should create a new status', async () => {
            const mockSavedStatus = {
                ...validStatus,
                _id: new mongoose.Types.ObjectId(),
                history: [{
                    status: STATUS_TYPES.OPEN,
                    timestamp: new Date(),
                    updatedBy: 'user123'
                }],
                toObject: () => mockSavedStatus
            };

            const mockTicketStatus = new TicketStatus(mockSavedStatus);
            mockTicketStatus.save.mockResolvedValue(mockSavedStatus);
            
            req.body = validStatus;
            await statusController.createStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                ticketId: validStatus.ticketId,
                currentStatus: validStatus.currentStatus
            }));
            expect(messageQueue.publishStatusCreated).toHaveBeenCalled();
        });

        it('should return 400 for invalid status', async () => {
            req.body = {
                ...validStatus,
                currentStatus: 'invalid_status'
            };

            await statusController.createStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('Invalid status value')
            }));
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
            const mockStatus = {
                ...validStatus,
                toObject: () => mockStatus
            };

            TicketStatus.findOne.mockResolvedValue(mockStatus);
            
            req.params.ticketId = ticketId;
            await statusController.getStatus(req, res);

            expect(res.status).not.toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(mockStatus);
        });

        it('should return 404 for non-existent ticketId', async () => {
            TicketStatus.findOne.mockResolvedValue(null);
            
            req.params.ticketId = ticketId;
            await statusController.getStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.any(String)
            }));
        });

        it('should return 400 for invalid ticketId format', async () => {
            req.params.ticketId = 'invalid-id';
            await statusController.getStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.any(String)
            }));
        });
    });

    describe('updateStatus', () => {
        const updateData = {
            status: STATUS_TYPES.IN_PROGRESS,
            updatedBy: 'user456',
            reason: 'Testing update'
        };

        it('should update status for valid transition', async () => {
            const mockStatus = {
                ...validStatus,
                updateStatus: jest.fn().mockResolvedValue({
                    ...validStatus,
                    currentStatus: STATUS_TYPES.IN_PROGRESS,
                    history: [
                        { status: STATUS_TYPES.OPEN, updatedBy: 'user123' },
                        { status: STATUS_TYPES.IN_PROGRESS, updatedBy: 'user456' }
                    ]
                })
            };

            TicketStatus.findOne.mockResolvedValue(mockStatus);
            
            req.params.ticketId = ticketId;
            req.body = updateData;
            await statusController.updateStatus(req, res);

            expect(res.json).toHaveBeenCalled();
            expect(mockStatus.updateStatus).toHaveBeenCalledWith(
                updateData.status,
                updateData.updatedBy,
                updateData.reason
            );
        });

        it('should create new status if ticket not found', async () => {
            TicketStatus.findOne.mockResolvedValue(null);
            
            req.params.ticketId = ticketId;
            req.body = updateData;
            await statusController.updateStatus(req, res);

            expect(res.json).toHaveBeenCalled();
        });

        it('should return 400 for invalid ticketId format', async () => {
            req.params.ticketId = 'invalid-id';
            req.body = updateData;
            await statusController.updateStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.any(String)
            }));
        });
    });

    describe('getStatusHistory', () => {
        it('should return status history', async () => {
            const mockHistory = [
                { status: STATUS_TYPES.OPEN, updatedBy: 'user123' },
                { status: STATUS_TYPES.IN_PROGRESS, updatedBy: 'user456' }
            ];

            const mockStatus = {
                ticketId,
                currentStatus: STATUS_TYPES.IN_PROGRESS,
                history: mockHistory,
                toObject: () => ({ ...mockStatus })
            };

            TicketStatus.findOne.mockResolvedValue(mockStatus);
            
            req.params.ticketId = ticketId;
            await statusController.getStatusHistory(req, res);

            expect(res.json).toHaveBeenCalledWith(mockHistory.slice(-10));
        });

        it('should return 400 for invalid ticketId format', async () => {
            req.params.ticketId = 'invalid-id';
            await statusController.getStatusHistory(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.any(String)
            }));
        });
    });

    describe('Event Handlers', () => {
        const ticketData = {
            id: ticketId,
            assignedTo: 'user456',
            resolvedBy: 'user789',
            closedBy: 'user123'
        };

        it('should handle ticket created event', async () => {
            await statusController.handleTicketCreated(ticketData);
            expect(TicketStatus).toHaveBeenCalledWith(expect.objectContaining({
                ticketId: ticketData.id,
                currentStatus: STATUS_TYPES.OPEN
            }));
        });

        it('should handle ticket assigned event', async () => {
            const mockStatus = {
                updateStatus: jest.fn().mockResolvedValue({})
            };
            TicketStatus.findOne.mockResolvedValue(mockStatus);

            await statusController.handleTicketAssigned(ticketData);
            expect(mockStatus.updateStatus).toHaveBeenCalledWith(
                STATUS_TYPES.IN_PROGRESS,
                'system',
                expect.any(String)
            );
        });

        it('should handle ticket resolved event', async () => {
            const mockStatus = {
                updateStatus: jest.fn().mockResolvedValue({})
            };
            TicketStatus.findOne.mockResolvedValue(mockStatus);

            await statusController.handleTicketResolved(ticketData);
            expect(mockStatus.updateStatus).toHaveBeenCalledWith(
                STATUS_TYPES.RESOLVED,
                'system',
                expect.any(String)
            );
        });

        it('should handle ticket closed event', async () => {
            const mockStatus = {
                updateStatus: jest.fn().mockResolvedValue({})
            };
            TicketStatus.findOne.mockResolvedValue(mockStatus);

            await statusController.handleTicketClosed(ticketData);
            expect(mockStatus.updateStatus).toHaveBeenCalledWith(
                STATUS_TYPES.CLOSED,
                'system',
                expect.any(String)
            );
        });
    });
}); 