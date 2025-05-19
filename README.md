# Status Service

This microservice tracks and manages the status of tickets in the system.

## Features

- Track the status of tickets (open, in_progress, resolved, closed)
- Store status history with timestamps and reasons for changes
- Validate status transitions
- Listen to ticket events via RabbitMQ
- Provide RESTful API for status updates and queries

## Environment Setup

The service is designed to run in both local development and Kubernetes environments.

### Prerequisites

- Node.js 18+
- MongoDB
- RabbitMQ

## Running Locally

### Option 1: Using Docker Compose

The easiest way to run the service locally is with Docker Compose:

```bash
# From the root project directory
docker-compose up status-service
```

### Option 2: Running Directly

1. Make sure MongoDB and RabbitMQ are running and accessible.

2. Set up environment variables:
   ```bash
   # Copy the local environment template
   cp .env.local .env
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Start the service:
   ```bash
   npm run dev
   ```

5. Or use the shortcut for local development:
   ```bash
   npm run dev:local
   ```

## Running in Kubernetes

### Deploying to Kubernetes

1. Build and push the Docker image to your registry:
   ```bash
   docker build -t your-registry/status-service:latest .
   docker push your-registry/status-service:latest
   ```

2. Update the image reference in `kubernetes/status-service/deployment.yaml` to match your registry.

3. Apply the Kubernetes configurations:
   ```bash
   kubectl apply -f kubernetes/status-service/configmap.yaml
   kubectl apply -f kubernetes/status-service/service.yaml
   kubectl apply -f kubernetes/status-service/deployment.yaml
   ```

## API Endpoints

### Status Endpoints

- `GET /status/:ticketId` - Get the current status of a ticket
- `GET /status/:ticketId/history` - Get the status history of a ticket
- `POST /status/:ticketId/update` - Update the status of a ticket

### Health Endpoints

- `GET /health/live` - Liveness probe endpoint
- `GET /health/ready` - Readiness probe endpoint

## RabbitMQ Event Handling

This service listens for the following events:

- `ticket.created` - When a new ticket is created
- `ticket.assigned` - When a ticket is assigned to someone
- `ticket.resolved` - When a ticket is resolved
- `ticket.closed` - When a ticket is closed

## Environment Variables

Environment variables can be configured in:
- `.env.local` - For local development
- `.env.kubernetes` - For Kubernetes deployment

See these files for all available configuration options.

## Deployment Options

### Local Development

For local development, use the standard `.env` file which contains configurations for local connections.

1. Run the service directly:
```bash
npm install
npm start
```

### Docker Development Environment

For a more production-like local environment, use Docker Compose:

```bash
cd kubernetes
docker-compose up
```

This will start the status service along with MongoDB and RabbitMQ in containers.

### Kubernetes Deployment

The service is configured for Kubernetes deployment. To deploy to Minikube or a Kubernetes cluster:

1. Build the Docker image:
```bash
docker build -t status-service:latest .
```

2. Apply the Kubernetes configurations:
```bash
kubectl apply -f kubernetes/deployment.yaml
kubectl apply -f kubernetes/service.yaml
```

3. Create the required secrets:
```bash
kubectl create secret generic microservice-secrets \
  --from-literal=jwt-secret=your_jwt_secret_here \
  --from-literal=service-api-key=microservice-internal-key
```

## Testing

Run the basic tests to ensure the service is functioning correctly:

```bash
npm test
```

To run with coverage reports:

```bash
npm run test:coverage
```

## Health Endpoints

The service provides the following health check endpoints:

- `/health/live` - Liveness probe endpoint
- `/health/ready` - Readiness probe endpoint
- `/health` - Detailed health status including MongoDB and RabbitMQ connections 