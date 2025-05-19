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

        // Check if status already exists
        const existingStatus = await TicketStatus.findOne({ ticketId });
        if (existingStatus) {
            return res.status(409).json({ 
                message: 'Status already exists for this ticket',
                status: existingStatus
            });
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
        
        // Publish status created event
        await messageQueue.publishStatusUpdated(
            ticketId,
            currentStatus,
            updatedBy,
            'Initial status'
        );
        
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
        const { ticketId } = req.params;
        
        if (!ticketId) {
            return res.status(400).json({ message: 'Ticket ID is required' });
        }
        
        const status = await TicketStatus.findOne({ ticketId });
        if (!status) {
            return res.status(404).json({ message: 'Status not found for this ticket' });
        }
        
        res.json(status);
    } catch (error) {
        console.error('Error getting status:', error.message);
        res.status(500).json({ message: error.message });
    }
};

// Get status history for a ticket
exports.getStatusHistory = async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { startDate, endDate, limit } = req.query;
        
        if (!ticketId) {
            return res.status(400).json({ message: 'Ticket ID is required' });
        }
        
        // Parse the limit if provided
        const parsedLimit = limit ? parseInt(limit, 10) : null;
        
        const status = await TicketStatus.findOne({ ticketId });
        if (!status) {
            return res.status(404).json({ message: 'Status not found for this ticket' });
        }
        
        const history = await TicketStatus.getStatusHistory(ticketId, { 
            startDate, 
            endDate,
            limit: parsedLimit
        });
        
        res.json(history);
    } catch (error) {
        console.error('Error getting status history:', error.message);
        res.status(500).json({ message: error.message });
    }
};

// Update status manually
exports.updateStatus = async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { status, updatedBy, reason } = req.body;

        if (!status || !updatedBy) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        let ticketStatus = await TicketStatus.findOne({ ticketId });
        const previousStatus = ticketStatus?.currentStatus;

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
            // Check if this is a potential duplicate by comparing to the most recent history entry
            let isDuplicate = false;
            if (ticketStatus.history && ticketStatus.history.length > 0) {
                const lastEntry = ticketStatus.history[ticketStatus.history.length - 1];
                const now = new Date();
                const lastEntryTime = new Date(lastEntry.timestamp);
                const timeDiffInSeconds = Math.abs((now - lastEntryTime) / 1000);
                
                // If the entry is very recent (within 5 seconds) and has the same status and similar reason
                if (
                    lastEntry.status === status && 
                    timeDiffInSeconds < 5 &&
                    lastEntry.updatedBy === updatedBy &&
                    (lastEntry.reason === reason || 
                     (lastEntry.reason && reason && 
                      (lastEntry.reason.includes(reason) || 
                       reason.includes(lastEntry.reason))))
                ) {
                    isDuplicate = true;
                }
            }
            
            // If it's not a duplicate, proceed with the update
            if (!isDuplicate) {
                // Check if status is actually changing
                if (ticketStatus.currentStatus === status) {
                    // Just add an entry to history without triggering status validation
                    await ticketStatus.addHistoryEntry(
                        updatedBy,
                        reason || `Status update to ${status} (no change)`
                    );
                } else {
                    // Status is changing, use updateStatus method
                    await ticketStatus.updateStatus(status, updatedBy, reason);
                }
            }
        }

        // Determine if we should prevent message looping
        // If it's a duplicate or if the request indicates it came from another service,
        // pass preventLoop=true to avoid sending a message back
        const preventLoop = req.body.fromMessageQueue === true || (req.headers && req.headers['x-from-service'] === 'true');

        // Publish status updated event
        await messageQueue.publishStatusUpdated(
            ticketId,
            status,
            updatedBy,
            reason || `Status changed from ${previousStatus} to ${status}`,
            preventLoop
        );

        res.json(ticketStatus);
    } catch (error) {
        console.error('Error updating status:', error.message);
        if (error.message.includes('Invalid status transition')) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: error.message });
    }
};

// Get latest status for multiple tickets
exports.getBatchStatus = async (req, res) => {
    try {
        const { ticketIds } = req.body;
        
        if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
            return res.status(400).json({ message: 'Valid array of ticket IDs is required' });
        }
        
        const statuses = await TicketStatus.getLatestStatusForTickets(ticketIds);
        
        // Create a map for quick lookup
        const statusMap = {};
        statuses.forEach(status => {
            statusMap[status.ticketId] = {
                currentStatus: status.currentStatus,
                lastUpdated: status.lastUpdated
            };
        });
        
        // Return object with ticket IDs as keys for quick client-side lookup
        res.json(statusMap);
    } catch (error) {
        console.error('Error getting batch status:', error.message);
        res.status(500).json({ message: error.message });
    }
};

// Get real-time status updates since a timestamp
exports.getStatusUpdates = async (req, res) => {
    try {
        const { since } = req.query;
        const { ticketIds } = req.body;
        
        if (!ticketIds || !Array.isArray(ticketIds)) {
            return res.status(400).json({ message: 'Valid array of ticket IDs is required' });
        }
        
        const updates = await TicketStatus.getStatusUpdates(ticketIds, since);
        
        res.json({
            timestamp: new Date().toISOString(),
            updates: updates.map(update => ({
                ticketId: update.ticketId,
                currentStatus: update.currentStatus,
                lastUpdated: update.lastUpdated,
                latestHistory: update.history.slice(-1)[0] // Include only the most recent history entry
            }))
        });
    } catch (error) {
        console.error('Error getting status updates:', error.message);
        res.status(500).json({ message: error.message });
    }
};

// Event handlers for RabbitMQ events
exports.handleTicketCreated = async (ticketData) => {
    try {
        // Check if a status already exists
        const existingStatus = await TicketStatus.findOne({ ticketId: ticketData.id });
        if (existingStatus) {
            console.log(`Status already exists for ticket ${ticketData.id}, skipping creation`);
            return;
        }
        
        const ticketStatus = new TicketStatus({
            ticketId: ticketData.id,
            currentStatus: STATUS_TYPES.OPEN,
            history: [{
                status: STATUS_TYPES.OPEN,
                updatedBy: ticketData.createdBy || 'system',
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
                ticketData.assignedBy || 'system',
                `Assigned to ${ticketData.assignedTo}`
            );
            console.log(`Status updated for assigned ticket ${ticketData.id}`);
        } else {
            console.warn(`No status found for ticket ${ticketData.id} during assignment`);
            // Create a new status if it doesn't exist
            await exports.handleTicketCreated({
                ...ticketData,
                createdBy: ticketData.assignedBy || 'system'
            });
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
                ticketData.resolvedBy || 'system',
                ticketData.reason || `Resolved by ${ticketData.resolvedBy}`
            );
            console.log(`Status updated for resolved ticket ${ticketData.id}`);
        } else {
            console.warn(`No status found for ticket ${ticketData.id} during resolution`);
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
                ticketData.closedBy || 'system',
                ticketData.reason || `Closed by ${ticketData.closedBy || 'system'}`
            );
            console.log(`Status updated for closed ticket ${ticketData.id}`);
        } else {
            console.warn(`No status found for ticket ${ticketData.id} during closure`);
        }
    } catch (error) {
        console.error('Error handling ticket closure:', error);
        throw error;
    }
}; 