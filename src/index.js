require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { TicketStatus } = require('./models/status');
const messageQueue = require('./messageQueue');

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:3002', 'http://ticket-service:3002'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id']
}));
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} [${req.method}] ${req.originalUrl}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Request body:', req.body);
  }
  
  // Capture the original send method
  const originalSend = res.send;
  
  // Override the send method
  res.send = function(body) {
    console.log(`Response for ${req.originalUrl}:`, 
      body?.length > 100 
        ? `${body.substring(0, 100)}... (truncated)` 
        : body);
    // Call the original send method
    originalSend.call(this, body);
  };
  
  next();
});

// Health check endpoint for Kubernetes
app.get('/health/live', (req, res) => {
    res.status(200).json({ status: 'OK' });
});

// Readiness check endpoint for Kubernetes
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

// Enhanced health check endpoint 
app.get('/health', async (req, res) => {
    try {
        // Check MongoDB connection
        const isMongoConnected = mongoose.connection.readyState === 1;
        
        // Check RabbitMQ connection
        const hasRabbitMQChannel = !!messageQueue.channel;
        
        // Try to execute a basic query to verify DB is truly operational
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
        
        // Return appropriate status code based on health
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

// Status Routes
app.get('/status/:ticketId', async (req, res) => {
    try {
        const status = await TicketStatus.findOne({ ticketId: req.params.ticketId });
        if (!status) {
            return res.status(404).json({ message: 'Status not found for this ticket' });
        }
        res.json(status);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/status/:ticketId/history', async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { startDate, endDate } = req.query;
        
        console.log(`Getting status history for ticket: ${ticketId}`);
        
        // Try to find status with the provided ID
        const history = await TicketStatus.getStatusHistory(ticketId, { startDate, endDate });
        
        if (!history) {
            console.log(`No history found for ticket: ${ticketId}`);
            return res.status(404).json({ 
                message: 'No history found for this ticket',
                ticketId
            });
        }
        
        console.log(`Found ${history.length} history entries for ticket: ${ticketId}`);
        res.json(history);
    } catch (error) {
        console.error(`Error getting status history: ${error.message}`);
        res.status(500).json({ message: error.message });
    }
});

app.post('/status/:ticketId/update', async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { status, updatedBy, reason } = req.body;
        
        console.log(`Updating status for ticket ${ticketId} to ${status} by ${updatedBy}`);
        
        if (!status || !updatedBy) {
            return res.status(400).json({ 
                message: 'Missing required fields: status and updatedBy are required',
                received: { status, updatedBy }
            });
        }

        let ticketStatus = await TicketStatus.findOne({ ticketId });
        
        if (!ticketStatus) {
            console.log(`Creating new status record for ticket ${ticketId}`);
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
            console.log(`Created initial status for ticket ${ticketId}`);
        } else {
            try {
                console.log(`Updating existing status for ticket ${ticketId} from ${ticketStatus.currentStatus} to ${status}`);
                await ticketStatus.updateStatus(status, updatedBy, reason);
                console.log(`Successfully updated status for ticket ${ticketId}`);
            } catch (error) {
                console.error(`Error updating status: ${error.message}`);
                if (error.message.includes('Invalid status transition')) {
                    return res.status(400).json({ message: error.message });
                }
                throw error;
            }
        }

        res.json(ticketStatus);
    } catch (error) {
        console.error(`Error in updateStatus: ${error.message}`);
        res.status(400).json({ message: error.message });
    }
});

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

// Check if running in local mode
const isLocal = process.env.IS_LOCAL === 'true';
console.log(`Running in ${isLocal ? 'LOCAL' : 'KUBERNETES'} mode`);

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

// Update the messageQueue.js module separately to handle local/k8s settings

// Start the application
const startApp = async () => {
    try {
        await connectMongoDB();
        await messageQueue.connect(isLocal);

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