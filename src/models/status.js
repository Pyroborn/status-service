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
        enum: Object.values(STATUS_TYPES),
        validate: {
            validator: function(value) {
                return Object.values(STATUS_TYPES).includes(value);
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
        enum: Object.values(STATUS_TYPES),
        default: STATUS_TYPES.OPEN,
        validate: {
            validator: function(value) {
                return Object.values(STATUS_TYPES).includes(value);
            },
            message: props => `${props.value} is not a valid status`
        }
    },
    history: [statusHistorySchema],
    lastUpdated: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Validate status transitions
ticketStatusSchema.methods.isValidTransition = function(newStatus) {
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
    
    return history;
};

const TicketStatus = mongoose.model('TicketStatus', ticketStatusSchema);

module.exports = {
    TicketStatus,
    STATUS_TYPES
}; 