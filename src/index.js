require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { TicketStatus } = require('./models/status');
const messageQueue = require('./messageQueue');
const authMiddleware = require('./middleware/auth');
const amqp = require('amqplib');

const app = express();

// Environment mode detection
const isLocal = process.env.IS_LOCAL === 'true';
console.log(`Running in ${isLocal ? 'LOCAL' : 'KUBERNETES'} mode`);

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',') 
    : ['http://localhost:3002', 'http://localhost:3000'];

app.use(cors({
    origin: allowedOrigins,
    methods: process.env.CORS_METHODS ? process.env.CORS_METHODS.split(',') : ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: process.env.CORS_HEADERS ? process.env.CORS_HEADERS.split(',') : ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition'],
    credentials: true
}));

// Request parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
    // Log request path
    console.log(`${req.method} ${req.path}`);
    
    // Detailed logging only in development
    if (process.env.NODE_ENV !== 'development') {
        return next();
    }
    
    if (req.body && Object.keys(req.body).length > 0) {
        console.log('Request body:', req.body);
    }
    
    // Capture original send method
    const originalSend = res.send;
    
    // Override send method for logging
    res.send = function(body) {
        console.log(`Response for ${req.path}:`, 
            body?.length > 100 
                ? `${body.substring(0, 100)}... (truncated)` 
                : body);
        originalSend.call(this, body);
    };
    
    next();
});

// Auth verification endpoint for service-to-service communication
app.get('/auth/verify', (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ 
                error: 'No authorization header provided',
                code: 'NO_AUTH_HEADER'
            });
        }

        // Service API key authentication
        if (authHeader.startsWith('ApiKey ')) {
            const apiKey = authHeader.split(' ')[1];
            if (apiKey === (process.env.SERVICE_API_KEY || 'microservice-internal-key')) {
                return res.status(200).json({ 
                    status: 'valid',
                    type: 'service',
                    role: 'service'
                });
            } else {
                return res.status(401).json({
                    error: 'Invalid API key',
                    code: 'INVALID_API_KEY'
                });
            }
        }

        // JWT verification
        if (authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            if (!token) {
                return res.status(401).json({ 
                    error: 'No token provided',
                    code: 'NO_TOKEN'
                });
            }

            const jwt = require('jsonwebtoken');
            const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
            
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                return res.status(200).json({
                    status: 'valid',
                    user: {
                        id: decoded.id,
                        email: decoded.email,
                        name: decoded.name || decoded.email,
                        role: decoded.role || 'user'
                    }
                });
            } catch (jwtError) {
                console.error('JWT verification error:', jwtError);
                return res.status(401).json({ 
                    error: 'Invalid or expired token',
                    code: 'INVALID_TOKEN'
                });
            }
        }

        return res.status(401).json({ 
            error: 'Invalid authorization format',
            code: 'INVALID_AUTH_FORMAT'
        });
    } catch (error) {
        console.error('Auth verification error:', error);
        res.status(500).json({ 
            error: 'Authentication verification error',
            code: 'AUTH_ERROR'
        });
    }
});

// Liveness probe for Kubernetes
app.get('/health/live', (req, res) => {
    res.status(200).json({ status: 'OK' });
});

// Readiness probe for Kubernetes
app.get('/health/ready', async (req, res) => {
    try {
        const isMongoConnected = mongoose.connection.readyState === 1;
        const hasChannel = !!messageQueue.channel;
        
        if (isMongoConnected && hasChannel) {
            res.status(200).json({
                status: 'Ready',
                mongodb: 'Connected',
                rabbitmq: 'Connected'
            });
        } else {
            res.status(503).json({
                status: 'Not Ready',
                mongodb: isMongoConnected ? 'Connected' : 'Disconnected',
                rabbitmq: hasChannel ? 'Connected' : 'Disconnected'
            });
        }
    } catch (error) {
        res.status(503).json({
            status: 'Error',
            error: error.message
        });
    }
});

// Comprehensive health check endpoint 
app.get('/health', async (req, res) => {
    try {
        // Check MongoDB connection
        const isMongoConnected = mongoose.connection.readyState === 1;
        
        // Check RabbitMQ connection
        const hasRabbitMQChannel = !!messageQueue.channel;
        
        // Verify database operational status
        let dbQuerySuccess = false;
        try {
            const count = await TicketStatus.countDocuments({}).exec();
            dbQuerySuccess = true;
            console.log(`DB health check: Found ${count} ticket status records`);
        } catch (err) {
            console.error('DB query error during health check:', err.message);
        }
        
        const status = {
            service: 'status-service',
            uptime: process.uptime(),
            timestamp: Date.now(),
            connections: {
                mongodb: {
                    connected: isMongoConnected,
                    operational: dbQuerySuccess
                },
                rabbitmq: {
                    connected: hasRabbitMQChannel
                }
            },
            environment: process.env.NODE_ENV,
            isLocal: process.env.IS_LOCAL === 'true'
        };
        
        // Return status code based on health
        if (isMongoConnected && dbQuerySuccess && hasRabbitMQChannel) {
            res.status(200).json(status);
        } else {
            res.status(503).json(status);
        }
    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({
            status: 'Error',
            error: error.message
        });
    }
});

// Status Routes - Protected by Auth Middleware
app.get('/status/:ticketId', authMiddleware, async (req, res) => {
    try {
        const status = await TicketStatus.findOne({ ticketId: req.params.ticketId });
        if (!status) {
            return res.status(404).json({ 
                message: 'Status not found for this ticket',
                ticketId: req.params.ticketId
            });
        }
        res.json(status);
    } catch (error) {
        console.error(`Error getting status: ${error.message}`);
        res.status(500).json({ message: error.message });
    }
});

app.get('/status/:ticketId/history', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { startDate, endDate, limit } = req.query;
        
        const parsedLimit = limit ? parseInt(limit, 10) : null;
        
        // Try to find status with the provided ID
        const history = await TicketStatus.getStatusHistory(ticketId, { 
            startDate, 
            endDate,
            limit: parsedLimit
        });
        
        if (!history) {
            return res.status(404).json({ 
                message: 'No history found for this ticket',
                ticketId
            });
        }
        
        res.json(history);
    } catch (error) {
        console.error(`Error getting status history: ${error.message}`);
        res.status(500).json({ message: error.message });
    }
});

// Update status for a ticket
app.post('/status/:ticketId/update', authMiddleware, async (req, res) => {
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
                // Check if the status is actually changing
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

        // Publish status updated event via RabbitMQ
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
});

// Get latest status for multiple tickets in a batch
app.post('/status/batch', authMiddleware, async (req, res) => {
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
});

// Get real-time status updates since a timestamp
app.post('/status/updates', authMiddleware, async (req, res) => {
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
                latestHistory: update.history.slice(-1)[0] // Only include most recent history entry
            }))
        });
    } catch (error) {
        console.error('Error getting status updates:', error.message);
        res.status(500).json({ message: error.message });
    }
});

// RabbitMQ connection
let channel;
const EXCHANGE_NAME = 'ticket_events';
const STATUS_ROUTING_KEY = 'ticket.status.updated';

async function setupRabbitMQ() {
    try {
        // Get RabbitMQ connection URL based on environment
        const rabbitMqUrl = isLocal 
            ? (process.env.LOCAL_RABBITMQ_URL || `amqp://${process.env.LOCAL_RABBITMQ_USER || 'guest'}:${process.env.LOCAL_RABBITMQ_PASS || 'guest'}@${process.env.LOCAL_RABBITMQ_HOST || 'localhost'}:${process.env.LOCAL_RABBITMQ_PORT || '5672'}`)
            : (process.env.RABBITMQ_URL || 'amqp://rabbitmq-service:5672');
            
        console.log(`Connecting to RabbitMQ at: ${rabbitMqUrl.replace(/:[^:]*@/, ':***@')}`); // Hide password in logs
        
        const connection = await amqp.connect(rabbitMqUrl);
        channel = await connection.createChannel();
        
        // Declare exchange
        await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });
        
        console.log('Successfully connected to RabbitMQ');
        
        // Handle connection closure
        connection.on('close', async () => {
            console.log('RabbitMQ connection closed');
            await retryConnection();
        });
    } catch (error) {
        console.error('Error connecting to RabbitMQ:', error);
        await retryConnection();
    }
}

async function retryConnection(retries = 5, delay = 5000) {
    for (let i = 1; i <= retries; i++) {
        console.log(`Attempting to reconnect (${i}/${retries})...`);
        try {
            await setupRabbitMQ();
            return;
        } catch (error) {
            if (i === retries) {
                console.error('Failed to reconnect to RabbitMQ after multiple attempts');
                process.exit(1);
            }
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ 
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Graceful shutdown
const gracefulShutdown = async () => {
    console.log('Received shutdown signal. Starting graceful shutdown...');
    
    // Close RabbitMQ connection
    await messageQueue.close();
    
    // Close MongoDB connection
    await mongoose.connection.close();
    
    // Close Express server
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
    
    // Force close after 30 seconds
    setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 30000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Connect to MongoDB
const connectMongoDB = async () => {
    try {
        // Determine which connection settings to use based on environment
        let mongoHost, mongoPort, mongoDb, mongoUser, mongoPass;
        
        if (isLocal) {
            // Use local settings
            mongoHost = process.env.LOCAL_MONGODB_HOST || 'localhost';
            mongoPort = process.env.LOCAL_MONGODB_PORT || '27017';
            mongoDb = process.env.LOCAL_MONGODB_DATABASE || 'status-service';
            mongoUser = process.env.LOCAL_MONGODB_USER;
            mongoPass = process.env.LOCAL_MONGODB_PASSWORD;
            console.log(`Using local MongoDB connection: ${mongoHost}:${mongoPort}/${mongoDb}`);
        } else {
            // Use kubernetes settings
            mongoHost = process.env.MONGODB_HOST || 'mongodb-service';
            mongoPort = process.env.MONGODB_PORT || '27017';
            mongoDb = process.env.MONGODB_DATABASE || 'status-service';
            mongoUser = process.env.MONGODB_USER;
            mongoPass = process.env.MONGODB_PASSWORD;
            console.log(`Using Kubernetes MongoDB connection: ${mongoHost}:${mongoPort}/${mongoDb}`);
        }

        let mongoUrl;
        if (mongoUser && mongoPass) {
            mongoUrl = `mongodb://${mongoUser}:${mongoPass}@${mongoHost}:${mongoPort}/${mongoDb}`;
        } else {
            mongoUrl = `mongodb://${mongoHost}:${mongoPort}/${mongoDb}`;
        }

        // Try to connect with retry logic
        let retries = 5;
        let connected = false;
        
        while (retries > 0 && !connected) {
            try {
                await mongoose.connect(mongoUrl, {
                    useNewUrlParser: true,
                    useUnifiedTopology: true
                });
                connected = true;
                console.log('Connected to MongoDB successfully');
            } catch (error) {
                retries--;
                if (retries === 0) {
                    throw error;
                }
                console.log(`MongoDB connection attempt failed. Retrying... (${retries} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds before retrying
            }
        }
    } catch (error) {
        console.error('MongoDB connection error:', error);
        throw error;
    }
};

// Start the application
const startApp = async () => {
    try {
        await connectMongoDB();
        await messageQueue.connect(isLocal);
        
        // Initialize RabbitMQ connection
        await setupRabbitMQ();

        const PORT = process.env.PORT || 4001;
        server = app.listen(PORT, () => {
            console.log(`Status service running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start application:', error);
        process.exit(1);
    }
};

// Declare server as a global variable so it can be accessed in gracefulShutdown
let server;

startApp(); 