# Use Node.js v18 as the base image
FROM node:18

# Create and set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    ffmpeg -version

# Expose port 8080
EXPOSE 8080

# Command to run the application
CMD [ "node", "server.js" ]
