FROM node:21.2.0

# Create Directory for the Container
WORKDIR /

# Copy all other source code to work directory
COPY ./* /

RUN yarn install

# Start
CMD ["node", "index.js"]
