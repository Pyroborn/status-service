const mongoose = require('mongoose');
const { TicketStatus, STATUS_TYPES } = require('../../src/models/status');

describe('Status Model Test', () => {
    const validStatusData = {
        ticketId: 'mock-object-id',
        currentStatus: STATUS_TYPES.OPEN,
        updatedBy: 'user123',
        history: [{
            status: STATUS_TYPES.OPEN,
            timestamp: new Date('2025-04-05T17:53:53.824Z'),
            updatedBy: 'user123'
        }]
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should create & save status successfully', async () => {
        const status = new TicketStatus(validStatusData);
        const savedStatus = await status.save();
        expect(savedStatus.ticketId).toBe(validStatusData.ticketId);
        expect(savedStatus.currentStatus).toBe(STATUS_TYPES.OPEN);
    });

    it('should fail to save status without required fields', async () => {
        const status = new TicketStatus({});
        let err;
        try {
            await status.save();
        } catch (error) {
            err = error;
        }
        expect(err).toBeInstanceOf(mongoose.Error.ValidationError);
    });

    it('should fail to save status with invalid status value', async () => {
        const status = new TicketStatus({
            ...validStatusData,
            currentStatus: 'invalid_status'
        });
        let err;
        try {
            await status.save();
        } catch (error) {
            err = error;
        }
        expect(err).toBeInstanceOf(mongoose.Error.ValidationError);
    });

    describe('Status Transitions', () => {
        it('should allow valid transitions', () => {
            const status = new TicketStatus(validStatusData);
            expect(status.isValidTransition(STATUS_TYPES.IN_PROGRESS)).toBe(true);
            expect(status.isValidTransition(STATUS_TYPES.CLOSED)).toBe(true);
        });

        it('should prevent invalid transitions', () => {
            const status = new TicketStatus(validStatusData);
            expect(status.isValidTransition(STATUS_TYPES.RESOLVED)).toBe(false);
        });

        it('should update status for valid transition', async () => {
            const status = new TicketStatus(validStatusData);
            const saveSpy = jest.spyOn(status, 'save').mockResolvedValueOnce(status);
            
            await status.updateStatus(STATUS_TYPES.IN_PROGRESS, 'user456', 'Testing transition');
            
            expect(status.currentStatus).toBe(STATUS_TYPES.IN_PROGRESS);
            expect(status.history).toHaveLength(2);
            expect(status.history[1]).toMatchObject({
                status: STATUS_TYPES.IN_PROGRESS,
                updatedBy: 'user456',
                reason: 'Testing transition'
            });
            expect(saveSpy).toHaveBeenCalled();
        });

        it('should reject invalid transitions', async () => {
            const status = new TicketStatus({
                ...validStatusData,
                currentStatus: STATUS_TYPES.CLOSED,
                history: [{
                    status: STATUS_TYPES.CLOSED,
                    timestamp: new Date('2025-04-05T17:53:53.824Z'),
                    updatedBy: 'user123'
                }]
            });

            let err;
            const originalHistory = [...status.history];
            const originalStatus = status.currentStatus;

            try {
                await status.updateStatus(STATUS_TYPES.IN_PROGRESS, 'user456', 'Testing transition');
            } catch (error) {
                err = error;
            }

            expect(err).toBeDefined();
            expect(err.message).toContain('Invalid status transition');
            expect(status.currentStatus).toBe(originalStatus);
            expect(status.history).toEqual(originalHistory);
            expect(status.history).toHaveLength(1);
        });
    });
}); 