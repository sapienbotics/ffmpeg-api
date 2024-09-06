# Use Node.js base image
FROM node:14

# Set working directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy app source code
COPY . .

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Expose port 8080
EXPOSE 8080

# Start the Node.js server
CMD ["node", "server.js"]
