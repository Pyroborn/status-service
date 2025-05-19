const mongoose = require('mongoose');

const STATUS_TYPES = {
    OPEN: 'open',
    IN_PROGRESS: 'in-progress',
    RESOLVED: 'resolved',
    CLOSED: 'closed'
};

const statusHistorySchema = new mongoose.Schema({
    status: {
        type: String,
        required: true,
        enum: [...Object.values(STATUS_TYPES), 'deleted'],
        validate: {
            validator: function(value) {
                return [...Object.values(STATUS_TYPES), 'deleted'].includes(value);
            },
            message: props => `${props.value} is not a valid status`
        }
    },
    timestamp: {
        type: Date,
        default: Date.now,
        required: true
    },
    updatedBy: {
        type: String,
        required: true,
        trim: true
    },
    reason: {
        type: String,
        trim: true
    }
});

const ticketStatusSchema = new mongoose.Schema({
    ticketId: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true
    },
    currentStatus: {
        type: String,
        required: true,
        enum: [...Object.values(STATUS_TYPES), 'deleted'],
        default: STATUS_TYPES.OPEN,
        validate: {
            validator: function(value) {
                return [...Object.values(STATUS_TYPES), 'deleted'].includes(value);
            },
            message: props => `${props.value} is not a valid status`
        }
    },
    history: [statusHistorySchema],
    lastUpdated: {
        type: Date,
        default: Date.now,
        index: true
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true
    }
}, {
    timestamps: true
});

// Validate status transitions
ticketStatusSchema.methods.isValidTransition = function(newStatus) {
    // If the ticket is deleted, no more transitions
    if (!this.isActive) {
        return false;
    }
    
    // If the new status is 'deleted', it's always valid
    if (newStatus === 'deleted') {
        return true;
    }
    
    const validTransitions = {
        [STATUS_TYPES.OPEN]: [STATUS_TYPES.IN_PROGRESS, STATUS_TYPES.CLOSED],
        [STATUS_TYPES.IN_PROGRESS]: [STATUS_TYPES.RESOLVED, STATUS_TYPES.CLOSED],
        [STATUS_TYPES.RESOLVED]: [STATUS_TYPES.CLOSED, STATUS_TYPES.IN_PROGRESS],
        [STATUS_TYPES.CLOSED]: [] // Cannot transition from closed
    };

    return validTransitions[this.currentStatus]?.includes(newStatus);
};

// Update status with validation
ticketStatusSchema.methods.updateStatus = async function(newStatus, updatedBy, reason) {
    // Normalize the status to handle both formats 'in-progress' and 'in_progress'
    let normalizedStatus = newStatus;
    if (newStatus === 'in_progress') normalizedStatus = 'in-progress';
    if (newStatus === 'in-progress') normalizedStatus = 'in-progress';

    // Special case for deleted status - always allowed but marks the ticket as inactive
    if (normalizedStatus === 'deleted') {
        this.isActive = false;
        this.currentStatus = 'deleted';
        
        this.history.push({
            status: 'deleted',
            updatedBy,
            reason: reason || 'Ticket deleted'
        });
        
        this.lastUpdated = new Date();
        return this.save();
    }

    // Check validation against normalized status
    if (!Object.values(STATUS_TYPES).includes(normalizedStatus)) {
        throw new Error(`Invalid status value: ${newStatus}. Valid values are: ${Object.values(STATUS_TYPES).join(', ')}`);
    }

    if (!this.isValidTransition(normalizedStatus)) {
        throw new Error(`Invalid status transition from ${this.currentStatus} to ${normalizedStatus}`);
    }

    this.history.push({
        status: normalizedStatus,
        updatedBy,
        reason: reason || `Status changed from ${this.currentStatus} to ${normalizedStatus}`
    });

    this.currentStatus = normalizedStatus;
    this.lastUpdated = new Date();

    return this.save();
};

// Add history entry without changing status
ticketStatusSchema.methods.addHistoryEntry = async function(updatedBy, reason) {
    // Add an entry to history without changing the current status
    this.history.push({
        status: this.currentStatus,
        updatedBy,
        reason: reason || `Ticket updated - no status change`
    });
    
    this.lastUpdated = new Date();
    return this.save();
};

// Get status history with optional filtering
ticketStatusSchema.statics.getStatusHistory = async function(ticketId, filter = {}) {
    const status = await this.findOne({ ticketId });
    if (!status) return null;

    let history = status.history;
    
    if (filter.startDate) {
        history = history.filter(h => h.timestamp >= new Date(filter.startDate));
    }
    if (filter.endDate) {
        history = history.filter(h => h.timestamp <= new Date(filter.endDate));
    }
    if (filter.limit) {
        history = history.slice(-filter.limit);
    }
    
    return history;
};

// Get real-time status updates for a list of tickets
ticketStatusSchema.statics.getStatusUpdates = async function(ticketIds, since = null) {
    const query = { ticketId: { $in: ticketIds } };
    
    if (since) {
        query.lastUpdated = { $gte: new Date(since) };
    }
    
    return this.find(query)
        .select('ticketId currentStatus lastUpdated history')
        .sort({ lastUpdated: -1 });
};

// Get latest status for multiple tickets
ticketStatusSchema.statics.getLatestStatusForTickets = async function(ticketIds) {
    if (!ticketIds || ticketIds.length === 0) {
        return [];
    }
    
    return this.find({ ticketId: { $in: ticketIds } })
        .select('ticketId currentStatus lastUpdated')
        .lean();
};

const TicketStatus = mongoose.model('TicketStatus', ticketStatusSchema);

module.exports = {
    TicketStatus,
    STATUS_TYPES
}; 