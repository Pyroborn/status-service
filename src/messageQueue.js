const amqp = require('amqplib');
const { TicketStatus, STATUS_TYPES } = require('./models/status');
const mongoose = require('mongoose');

class MessageQueue {
    constructor() {
        this.channel = null;
        this.connection = null;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.retryDelay = 5000; // 5 seconds
    }

    async connect(isLocal = false) {
        try {
            let rabbitmqHost, rabbitmqPort, rabbitmqUser, rabbitmqPass;

            if (isLocal) {
                // Use local configuration
                rabbitmqHost = process.env.LOCAL_RABBITMQ_HOST || 'localhost';
                rabbitmqPort = process.env.LOCAL_RABBITMQ_PORT || '5672';
                rabbitmqUser = process.env.LOCAL_RABBITMQ_USER || 'guest';
                rabbitmqPass = process.env.LOCAL_RABBITMQ_PASS || 'guest';
                console.log(`Using local RabbitMQ connection: ${rabbitmqHost}:${rabbitmqPort}`);
            } else {
                // Use Kubernetes configuration
                rabbitmqHost = process.env.RABBITMQ_HOST || 'rabbitmq-service';
                rabbitmqPort = process.env.RABBITMQ_PORT || '5672';
                rabbitmqUser = process.env.RABBITMQ_USER || 'guest';
                rabbitmqPass = process.env.RABBITMQ_PASS || 'guest';
                console.log(`Using Kubernetes RabbitMQ connection: ${rabbitmqHost}:${rabbitmqPort}`);
            }

            const connectionString = `amqp://${rabbitmqUser}:${rabbitmqPass}@${rabbitmqHost}:${rabbitmqPort}`;
            
            // Add connection attempt logging
            console.log(`Attempting to connect to RabbitMQ at ${rabbitmqHost}:${rabbitmqPort}`);
            
            this.connection = await amqp.connect(connectionString);
            this.channel = await this.connection.createChannel();

            // Reset retry count on successful connection
            this.retryCount = 0;

            // Handle connection events
            this.connection.on('error', this.handleConnectionError.bind(this));
            this.connection.on('close', this.handleConnectionClose.bind(this));

            console.log('Successfully connected to RabbitMQ');
            
            // Set up exchanges and queues
            await this.setupExchangesAndQueues();
            
            return true;
        } catch (error) {
            console.error('Failed to connect to RabbitMQ:', error.message);
            return this.handleConnectionFailure(isLocal);
        }
    }

    async setupExchangesAndQueues() {
        try {
            // Declare exchanges
            await this.channel.assertExchange('ticket_events', 'topic', { durable: true });

            // Declare queues
            await this.channel.assertQueue('status_service_queue', { durable: true });

            // Bind queues to exchanges with specific routing keys
            const routingKeys = [
                'ticket.created',
                'ticket.updated',
                'ticket.status.changed',
                'ticket.assigned',
                'ticket.resolved',
                'ticket.deleted'
            ];

            for (const key of routingKeys) {
                await this.channel.bindQueue('status_service_queue', 'ticket_events', key);
            }

            // Start consuming messages
            await this.consumeMessages();
        } catch (error) {
            console.error('Error setting up exchanges and queues:', error);
            throw error;
        }
    }

    async consumeMessages() {
        try {
            await this.channel.consume('status_service_queue', async (msg) => {
                try {
                    if (!msg) return;
                    
                    const content = JSON.parse(msg.content.toString());
                    await this.processMessage(content);
                    this.channel.ack(msg);
                } catch (error) {
                    // Log only error message, not the full stack trace for common errors
                    console.error('Message processing error:', error.message);
                    
                    // For common status validation errors, don't requeue to avoid message storms
                    const shouldRequeue = this.isRetryableError(error);
                    
                    try {
                        // Nack the message - don't requeue validation errors
                        this.channel.nack(msg, false, shouldRequeue);
                    } catch (nackError) {
                        console.error('Error in nack operation:', nackError.message);
                    }
                }
            });
        } catch (error) {
            console.error('Error setting up message consumer:', error.message);
            throw error;
        }
    }

    async processMessage(message) {
        try {
            const { type, data } = message;
            const eventType = type || (message.data ? message.data.type : null);
            const eventData = data || message.data;

            if (!eventData) {
                console.error('Invalid message format, missing data:', message);
                return;
            }

            // Only log message type, not the entire message
            console.log(`Processing message type: ${eventType}`);

            switch (eventType) {
                case 'ticket.created':
                    await this.handleTicketCreated(eventData);
                    break;
                case 'ticket.updated':
                    await this.handleTicketUpdated(eventData);
                    break;
                case 'ticket.status.changed':
                    await this.handleTicketStatusChanged(eventData);
                    break;
                case 'ticket.assigned':
                    await this.handleTicketAssigned(eventData);
                    break;
                case 'ticket.resolved':
                    await this.handleTicketResolved(eventData);
                    break;
                case 'ticket.deleted':
                    await this.handleTicketDeleted(eventData);
                    break;
                default:
                    console.warn('Unknown message type:', eventType);
            }
        } catch (error) {
            console.error('Error processing message:', error.message);
            throw error;
        }
    }

    async handleTicketCreated(data) {
        try {
            // Avoid duplicates
            const existingStatus = await TicketStatus.findOne({ ticketId: data.id });
            if (existingStatus) {
                return;
            }
            
            const status = new TicketStatus({
                ticketId: data.id,
                currentStatus: STATUS_TYPES.OPEN,
                history: [{
                    status: STATUS_TYPES.OPEN,
                    updatedBy: data.createdBy || 'system',
                    reason: 'Ticket created'
                }]
            });
            await status.save();
            console.log(`Created status for ticket ${data.id}`);
        } catch (error) {
            console.error(`Error creating status for ticket ${data.id}:`, error.message);
            throw error;
        }
    }

    async handleTicketUpdated(data) {
        try {
            let status = await TicketStatus.findOne({ ticketId: data.id });
            
            // If status doesn't exist, create it
            if (!status) {
                status = new TicketStatus({
                    ticketId: data.id,
                    currentStatus: data.currentStatus || STATUS_TYPES.OPEN,
                    history: []
                });
                // Save initial status
                await status.save();
                return;
            }
            
            // Check if this is a duplicate entry by comparing to the most recent history entry
            if (status.history && status.history.length > 0) {
                const lastEntry = status.history[status.history.length - 1];
                const now = new Date();
                const lastEntryTime = new Date(lastEntry.timestamp);
                const timeDiffInSeconds = Math.abs((now - lastEntryTime) / 1000);
                
                // If the entry is very recent (within 5 seconds) and has the same status and similar reason
                if (
                    lastEntry.status === (data.currentStatus || status.currentStatus) && 
                    timeDiffInSeconds < 5 &&
                    (lastEntry.reason === data.reason || 
                     (lastEntry.reason && data.reason && 
                      (lastEntry.reason.includes(data.reason) || 
                       data.reason.includes(lastEntry.reason))))
                ) {
                    return;
                }
            }
            
            // If status has changed, add to history
            if (data.previousStatus && data.currentStatus && data.previousStatus !== data.currentStatus) {
                // Check if the current database status matches the incoming status
                if (status.currentStatus === data.currentStatus) {
                    // Record the update attempt in history without changing status
                    // Only if we have a meaningful reason to record
                    if (data.reason && !data.reason.includes(`Status changed from ${data.previousStatus} to ${data.currentStatus}`)) {
                        await status.addHistoryEntry(
                            data.updatedBy || 'system',
                            `Status unchanged: ${data.reason}`
                        );
                    }
                    return;
                }
                
                await status.updateStatus(
                    data.currentStatus,
                    data.updatedBy || 'system',
                    data.reason || `Status changed from ${data.previousStatus} to ${data.currentStatus}`
                );
            } else {
                // If no status change but we have a reason, record it in history
                // Only if we have a meaningful reason to record
                if (data.reason && data.reason !== `Status changed from ${data.previousStatus || status.currentStatus} to ${data.currentStatus || status.currentStatus}`) {
                    await status.addHistoryEntry(
                        data.updatedBy || 'system',
                        `General update: ${data.reason}`
                    );
                }
            }
        } catch (error) {
            console.error(`Error updating status for ticket ${data.id}:`, error.message);
            throw error;
        }
    }

    async handleTicketStatusChanged(data) {
        try {
            let status = await TicketStatus.findOne({ ticketId: data.id });
            
            // If status doesn't exist, create it
            if (!status) {
                status = new TicketStatus({
                    ticketId: data.id,
                    currentStatus: data.currentStatus,
                    history: []
                });
                // Save initial status
                await status.save();
                return;
            }
            
            // Check if this is a duplicate entry by comparing to the most recent history entry
            if (status.history && status.history.length > 0) {
                const lastEntry = status.history[status.history.length - 1];
                const now = new Date();
                const lastEntryTime = new Date(lastEntry.timestamp);
                const timeDiffInSeconds = Math.abs((now - lastEntryTime) / 1000);
                
                // If the entry is very recent (within 5 seconds) and has the same status and reason
                if (
                    lastEntry.status === data.currentStatus && 
                    timeDiffInSeconds < 5 &&
                    (lastEntry.reason === data.reason || 
                     (lastEntry.reason && data.reason && 
                      lastEntry.reason.includes(data.reason) || 
                      data.reason.includes(lastEntry.reason)))
                ) {
                    return;
                }
            }
            
            // Skip update if the status hasn't actually changed
            if (status.currentStatus === data.currentStatus) {
                // Only add history if we have a reason and it's not a duplicate
                if (data.reason) {
                    await status.addHistoryEntry(
                        data.updatedBy || 'system',
                        `Status unchanged: ${data.reason}`
                    );
                }
                return;
            }
            
            await status.updateStatus(
                data.currentStatus,
                data.updatedBy || 'system',
                data.reason || `Status changed from ${data.previousStatus} to ${data.currentStatus}`
            );
        } catch (error) {
            console.error(`Error handling status change for ticket ${data.id}:`, error.message);
            throw error;
        }
    }

    async handleTicketAssigned(data) {
        try {
            const status = await TicketStatus.findOne({ ticketId: data.id });
            if (!status) {
                return;
            }
            
            if (status.currentStatus === STATUS_TYPES.IN_PROGRESS) {
                // If already in progress, just add a history entry
                await status.addHistoryEntry(
                    data.assignedBy || 'system',
                    `Assigned to ${data.assignedTo}`
                );
            } else {
                await status.updateStatus(
                    STATUS_TYPES.IN_PROGRESS,
                    data.assignedBy || 'system',
                    `Assigned to ${data.assignedTo}`
                );
            }
        } catch (error) {
            console.error(`Error handling ticket assignment for ${data.id}:`, error.message);
            throw error;
        }
    }

    async handleTicketResolved(data) {
        try {
            const status = await TicketStatus.findOne({ ticketId: data.id });
            if (!status) {
                return;
            }
            
            // Check if this is a duplicate or no-change event
            if (status.currentStatus === STATUS_TYPES.RESOLVED) {
                // Check if we should add a history entry
                if (status.history && status.history.length > 0) {
                    const lastEntry = status.history[status.history.length - 1];
                    const now = new Date();
                    const lastEntryTime = new Date(lastEntry.timestamp);
                    const timeDiffInSeconds = Math.abs((now - lastEntryTime) / 1000);
                    
                    // Skip if very recent duplicate
                    if (timeDiffInSeconds < 5 && 
                        lastEntry.updatedBy === (data.resolvedBy || 'system') &&
                        (lastEntry.reason && data.reason && 
                         (lastEntry.reason.includes(data.reason) || 
                          data.reason.includes(lastEntry.reason)))) {
                        return;
                    }
                }
                
                // Add history entry without changing status
                await status.addHistoryEntry(
                    data.resolvedBy || 'system',
                    data.reason || `Resolved by ${data.resolvedBy}`
                );
            } else {
                // Status is actually changing, use updateStatus
                await status.updateStatus(
                    STATUS_TYPES.RESOLVED,
                    data.resolvedBy || 'system',
                    data.reason || `Resolved by ${data.resolvedBy}`
                );
            }
        } catch (error) {
            console.error(`Error handling ticket resolution for ${data.id}:`, error.message);
            throw error;
        }
    }

    async handleTicketDeleted(data) {
        try {
            // When a ticket is deleted, we keep the status history for audit purposes
            // but mark it as inactive
            const status = await TicketStatus.findOne({ ticketId: data.id });
            if (!status) {
                return;
            }
            
            status.isActive = false;
            status.history.push({
                status: 'deleted',
                updatedBy: 'system',
                reason: 'Ticket deleted'
            });
            await status.save();
        } catch (error) {
            console.error(`Error handling ticket deletion for ${data.id}:`, error.message);
            throw error;
        }
    }
    
    // Add a method to publish status updates back to the ticket service
    async publishStatusUpdated(ticketId, status, updatedBy, reason, preventLoop = false) {
        try {
            // If preventLoop is true, skip publishing to avoid message loops
            if (preventLoop) {
                return true;
            }
            
            if (!this.channel) {
                await this.connect();
            }
            
            const message = {
                type: 'ticket.status.updated',
                data: {
                    ticketId,
                    status,
                    updatedBy,
                    reason,
                    timestamp: new Date().toISOString()
                }
            };
            
            const success = this.channel.publish(
                'ticket_events',
                'ticket.status.updated',
                Buffer.from(JSON.stringify(message)),
                { persistent: true }
            );
            
            if (!success) {
                console.error(`Failed to publish status update for ticket ${ticketId}`);
            }
            
            return success;
        } catch (error) {
            console.error(`Error publishing status update for ticket ${ticketId}:`, error.message);
            return false;
        }
    }

    handleConnectionError(error) {
        console.error('RabbitMQ connection error:', error);
        this.attemptReconnect();
    }

    handleConnectionClose() {
        console.log('RabbitMQ connection closed');
        this.attemptReconnect();
    }

    async attemptReconnect() {
        if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            console.log(`Attempting to reconnect (${this.retryCount}/${this.maxRetries})...`);
            setTimeout(() => this.connect(), this.retryDelay);
        } else {
            console.error('Max reconnection attempts reached');
            process.exit(1);
        }
    }

    handleConnectionFailure(isLocal) {
        if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            console.log(`Connection attempt failed. Retrying (${this.retryCount}/${this.maxRetries})...`);
            setTimeout(() => this.connect(isLocal), this.retryDelay);
            return false;
        } else {
            console.error('Max connection attempts reached');
            process.exit(1);
        }
    }

    isRetryableError(error) {
        // Don't retry validation errors
        if (error.message.includes('validation failed') || 
            error.message.includes('Invalid status') ||
            error.message.includes('transition from')) {
            return false;
        }
        return true;
    }

    async close() {
        try {
            await this.channel?.close();
            await this.connection?.close();
        } catch (error) {
            console.error('Error closing RabbitMQ connections:', error);
        }
    }
}

module.exports = new MessageQueue(); 