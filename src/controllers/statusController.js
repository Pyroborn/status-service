const { TicketStatus, STATUS_TYPES } = require('../models/status');
const mongoose = require('mongoose');
const { isValidObjectId } = mongoose;
const messageQueue = require('../messageQueue');

// Create a new status
exports.createStatus = async (req, res) => {
    try {
        const { ticketId, currentStatus, updatedBy } = req.body;

        if (!ticketId || !currentStatus || !updatedBy) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Validate status value before creating
        if (!Object.values(STATUS_TYPES).includes(currentStatus)) {
            return res.status(400).json({ message: 'Invalid status value' });
        }

        const ticketStatus = new TicketStatus({
            ticketId,
            currentStatus,
            history: [{
                status: currentStatus,
                updatedBy,
                reason: 'Initial status'
            }]
        });

        const savedStatus = await ticketStatus.save();
        await messageQueue.publishStatusCreated(savedStatus);
        res.status(201).json(savedStatus);
    } catch (error) {
        console.error('Error creating status:', error);
        if (error instanceof mongoose.Error.ValidationError) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: error.message });
    }
};

// Get status for a ticket
exports.getStatus = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.ticketId)) {
            return res.status(400).json({ message: 'Invalid ticket ID format' });
        }
        const status = await TicketStatus.findOne({ ticketId: req.params.ticketId });
        if (!status) {
            return res.status(404).json({ message: 'Status not found for this ticket' });
        }
        res.json(status);
    } catch (error) {
        console.error('Error getting status:', error);
        res.status(500).json({ message: error.message });
    }
};

// Get status history for a ticket
exports.getStatusHistory = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.ticketId)) {
            return res.status(400).json({ message: 'Invalid ticket ID format' });
        }
        const status = await TicketStatus.findOne({ ticketId: req.params.ticketId });
        if (!status) {
            return res.status(404).json({ message: 'Status not found for this ticket' });
        }
        res.json(status.history.slice(-10));
    } catch (error) {
        console.error('Error getting status history:', error);
        res.status(500).json({ message: error.message });
    }
};

// Update status manually
exports.updateStatus = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.ticketId)) {
            return res.status(400).json({ message: 'Invalid ticket ID format' });
        }
        const { ticketId } = req.params;
        const { status, updatedBy, reason } = req.body;

        if (!status || !updatedBy) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        let ticketStatus = await TicketStatus.findOne({ ticketId });

        if (!ticketStatus) {
            ticketStatus = new TicketStatus({
                ticketId,
                currentStatus: status,
                history: [{
                    status,
                    updatedBy,
                    reason: reason || 'Initial status'
                }]
            });
            await ticketStatus.save();
        } else {
            await ticketStatus.updateStatus(status, updatedBy, reason);
        }

        res.json(ticketStatus);
    } catch (error) {
        console.error('Error updating status:', error);
        if (error.message.includes('Invalid status transition')) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: error.message });
    }
};

// Event handlers for RabbitMQ events
exports.handleTicketCreated = async (ticketData) => {
    try {
        const ticketStatus = new TicketStatus({
            ticketId: ticketData.id,
            currentStatus: STATUS_TYPES.OPEN,
            history: [{
                status: STATUS_TYPES.OPEN,
                updatedBy: 'system',
                reason: 'Ticket created'
            }]
        });
        await ticketStatus.save();
        console.log(`Status created for ticket ${ticketData.id}`);
    } catch (error) {
        console.error('Error handling ticket creation:', error);
        throw error;
    }
};

exports.handleTicketAssigned = async (ticketData) => {
    try {
        const ticketStatus = await TicketStatus.findOne({ ticketId: ticketData.id });
        if (ticketStatus) {
            await ticketStatus.updateStatus(
                STATUS_TYPES.IN_PROGRESS,
                'system',
                `Assigned to ${ticketData.assignedTo}`
            );
            console.log(`Status updated for assigned ticket ${ticketData.id}`);
        }
    } catch (error) {
        console.error('Error handling ticket assignment:', error);
        throw error;
    }
};

exports.handleTicketResolved = async (ticketData) => {
    try {
        const ticketStatus = await TicketStatus.findOne({ ticketId: ticketData.id });
        if (ticketStatus) {
            await ticketStatus.updateStatus(
                STATUS_TYPES.RESOLVED,
                'system',
                `Resolved by ${ticketData.resolvedBy}`
            );
            console.log(`Status updated for resolved ticket ${ticketData.id}`);
        }
    } catch (error) {
        console.error('Error handling ticket resolution:', error);
        throw error;
    }
};

exports.handleTicketClosed = async (ticketData) => {
    try {
        const ticketStatus = await TicketStatus.findOne({ ticketId: ticketData.id });
        if (ticketStatus) {
            await ticketStatus.updateStatus(
                STATUS_TYPES.CLOSED,
                'system',
                `Closed by ${ticketData.closedBy}`
            );
            console.log(`Status updated for closed ticket ${ticketData.id}`);
        }
    } catch (error) {
        console.error('Error handling ticket closure:', error);
        throw error;
    }
}; 