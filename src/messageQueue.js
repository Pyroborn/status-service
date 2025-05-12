const amqp = require('amqplib');
const { TicketStatus, STATUS_TYPES } = require('./models/status');

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
                'ticket.assigned',
                'ticket.resolved',
                'ticket.closed'
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
                    const content = JSON.parse(msg.content.toString());
                    console.log('Received message:', content);

                    await this.processMessage(content);
                    this.channel.ack(msg);
                } catch (error) {
                    console.error('Error processing message:', error);
                    // Nack and requeue if it's a temporary error
                    this.channel.nack(msg, false, this.isRetryableError(error));
                }
            });
        } catch (error) {
            console.error('Error setting up message consumer:', error);
            throw error;
        }
    }

    async processMessage(message) {
        const { type, data } = message;

        switch (type) {
            case 'ticket.created':
                await this.handleTicketCreated(data);
                break;
            case 'ticket.assigned':
                await this.handleTicketAssigned(data);
                break;
            case 'ticket.resolved':
                await this.handleTicketResolved(data);
                break;
            case 'ticket.closed':
                await this.handleTicketClosed(data);
                break;
            default:
                console.warn('Unknown message type:', type);
        }
    }

    async handleTicketCreated(data) {
        const status = new TicketStatus({
            ticketId: data.id,
            currentStatus: STATUS_TYPES.OPEN,
            history: [{
                status: STATUS_TYPES.OPEN,
                updatedBy: 'system',
                reason: 'Ticket created'
            }]
        });
        await status.save();
    }

    async handleTicketAssigned(data) {
        const status = await TicketStatus.findOne({ ticketId: data.id });
        if (status) {
            await status.updateStatus(
                STATUS_TYPES.IN_PROGRESS,
                'system',
                `Assigned to ${data.assignedTo}`
            );
        }
    }

    async handleTicketResolved(data) {
        const status = await TicketStatus.findOne({ ticketId: data.id });
        if (status) {
            await status.updateStatus(
                STATUS_TYPES.RESOLVED,
                'system',
                `Resolved by ${data.resolvedBy}`
            );
        }
    }

    async handleTicketClosed(data) {
        const status = await TicketStatus.findOne({ ticketId: data.id });
        if (status) {
            await status.updateStatus(
                STATUS_TYPES.CLOSED,
                'system',
                `Closed by ${data.closedBy}`
            );
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
        // Add logic to determine if an error is retryable
        return !error.message.includes('validation failed');
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