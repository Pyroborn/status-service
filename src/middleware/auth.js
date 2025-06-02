const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');

// Service API Key for internal service communication
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || 'microservice-internal-key';

const authMiddleware = (req, res, next) => {
    try {
        console.log('=== AUTH MIDDLEWARE CALLED ===');
        
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            console.log('No authorization header provided');
            return res.status(401).json({ 
                error: 'No authorization header provided',
                code: 'NO_AUTH_HEADER'
            });
        }

        console.log('Auth header found:', authHeader.substring(0, 15) + '...');

        // Handle service API key authentication
        if (authHeader.startsWith('ApiKey ')) {
            const apiKey = authHeader.split(' ')[1];
            if (apiKey === SERVICE_API_KEY) {
                // Set service user for internal service calls
                req.user = {
                    id: 'service',
                    userId: 'service',
                    email: 'service@internal',
                    name: 'System Service',
                    role: 'service'
                };
                console.log('Service API key authentication successful');
                return next();
            } else {
                console.log('Invalid API key');
                return res.status(401).json({
                    error: 'Invalid API key',
                    code: 'INVALID_API_KEY'
                });
            }
        }

        // Regular JWT token authentication
        if (!authHeader.startsWith('Bearer ')) {
            console.log('Invalid authorization format');
            return res.status(401).json({ 
                error: 'Invalid authorization format. Must be Bearer token or ApiKey',
                code: 'INVALID_AUTH_FORMAT'
            });
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            console.log('No token provided');
            return res.status(401).json({ 
                error: 'No token provided',
                code: 'NO_TOKEN'
            });
        }

        try {
            console.log('JWT_SECRET length:', jwtConfig.JWT_SECRET.length);
            console.log('Token first 20 chars:', token.substring(0, 20) + '...');
            
            // Show token payload without verification for debugging
            const payload = jwtConfig.decodeToken(token);
            if (payload) {
                console.log('Token payload (decoded, not verified):', JSON.stringify(payload));
            } else {
                console.log('Error decoding token payload');
            }
            
            // Verify the token with our consistent JWT config
            const decoded = jwt.verify(token, jwtConfig.JWT_SECRET);
            console.log('Token successfully verified with secret');
            console.log('Decoded token:', JSON.stringify(decoded));
            
            // Handle both userId and id field naming
            const userId = decoded.userId || decoded.id;
            const email = decoded.email;
            
            // Validate required fields in token
            if (!userId && !email) {
                console.log('Token missing required fields');
                throw new Error('Invalid token payload - missing userId/id or email');
            }

            // Add user info to request
            req.user = {
                id: userId,
                userId: userId, // Ensure both fields are set for compatibility
                email: email || 'unknown@example.com',
                name: decoded.name || email || 'Unknown User',
                role: decoded.role || 'user'
            };
            
            console.log('User authenticated:', req.user.id, req.user.email, req.user.role);
            next();
        } catch (jwtError) {
            console.error('JWT verification error:', jwtError);
            return res.status(401).json({ 
                error: 'Invalid or expired token',
                code: 'INVALID_TOKEN'
            });
        }
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.status(500).json({ 
            error: 'Authentication error',
            code: 'AUTH_ERROR'
        });
    }
};

module.exports = authMiddleware; 