FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

# Copy all application files
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=4001

EXPOSE 4001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD wget -qO- http://localhost:4001/health/live || exit 1

# Use the standard entrypoint
CMD ["node", "src/index.js"] 