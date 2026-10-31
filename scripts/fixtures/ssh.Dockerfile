FROM postgres:16-alpine
RUN apk add --no-cache openssh coreutils python3 \
    && echo 'root:rookery_test' | chpasswd \
    && printf '\nPasswordAuthentication yes\nPermitRootLogin yes\nAllowTcpForwarding yes\n' >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e -o AllowTcpForwarding=yes -o PermitRootLogin=yes"]
