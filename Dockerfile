# Use an official Node.js image
FROM node:18

# Create app directory
WORKDIR /usr/src/app

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy rest of the server code
COPY . .

# Expose the port your server runs on
EXPOSE 3000

# Start the server
CMD [ "npm", "start" ]
