FROM alpine:3.22
RUN apk add --no-cache iproute2
COPY setup-vlans.sh /usr/local/bin/setup-vlans
ENTRYPOINT ["/usr/local/bin/setup-vlans"]
