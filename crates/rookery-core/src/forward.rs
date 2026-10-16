//! Loopback port forwarding: a listener on `127.0.0.1:<random>` whose connections are
//! piped to a remote address. Used by SQL "through a server" and, later, by Tunnels.
//!
//! - Loopback only: nothing on the network can use the forward.
//! - Each accepted connection gets its own upstream (an SSH `direct-tcpip` channel).
//! - Dropping the [`Forwarder`] stops accepting; the SSH lease is released when the
//!   last forwarded connection ends.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::ssh::Lease;
use crate::{Error, Result};

pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

pub type Upstream = Box<dyn Duplex>;
type DialFuture = Pin<Box<dyn Future<Output = Result<Upstream>> + Send>>;
/// Opens one upstream connection.
pub type Dial = Arc<dyn Fn() -> DialFuture + Send + Sync>;

pub struct Forwarder {
    pub local_port: u16,
    accept: JoinHandle<()>,
}

impl Forwarder {
    /// Listen on `127.0.0.1:0` and pipe every connection to what `dial` opens.
    pub async fn start(dial: Dial) -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let local_port = listener.local_addr()?.port();
        let accept = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let _ = sock.set_nodelay(true);
                let dial = dial.clone();
                tokio::spawn(async move {
                    match dial().await {
                        Ok(mut up) => {
                            let _ = tokio::io::copy_bidirectional(&mut sock, &mut up).await;
                        }
                        Err(e) => tracing::debug!("forward: could not open upstream: {e}"),
                    }
                });
            }
        });
        Ok(Self { local_port, accept })
    }

    /// Forward to `address:port` as seen from the server, through its SSH session.
    /// The lease keeps the session open while the forward (or a connection through it) lives.
    pub async fn ssh(lease: Lease, address: String, port: u16) -> Result<Self> {
        let lease = Arc::new(lease);
        let dial: Dial = Arc::new(move || {
            let lease = lease.clone();
            let address = address.clone();
            Box::pin(async move {
                // Fetch the handle per connection: it changes after an SSH reconnect.
                let h = lease.handle().await?;
                let ch = h
                    .channel_open_direct_tcpip(address.clone(), u32::from(port), "127.0.0.1", 0)
                    .await
                    .map_err(|e| Error::Ssh(format!("the server could not reach {address}:{port} ({e})")))?;
                Ok(Box::new(ch.into_stream()) as Upstream)
            })
        });
        Self::start(dial).await
    }
}

impl Drop for Forwarder {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Upstream = a local echo server standing in for the SSH channel.
    #[tokio::test]
    async fn pipes_bytes_both_ways_and_stops_when_dropped() {
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = echo.accept().await.unwrap();
                tokio::spawn(async move {
                    let (mut r, mut w) = s.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });
        let dial: Dial = Arc::new(move || {
            Box::pin(async move {
                let s = tokio::net::TcpStream::connect(("127.0.0.1", echo_port)).await?;
                Ok(Box::new(s) as Upstream)
            })
        });
        let fwd = Forwarder::start(dial).await.unwrap();
        let port = fwd.local_port;

        for msg in [&b"hello"[..], &b"second connection"[..]] {
            let mut c = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            c.write_all(msg).await.unwrap();
            let mut buf = vec![0u8; msg.len()];
            c.read_exact(&mut buf).await.unwrap();
            assert_eq!(buf, msg);
        }

        drop(fwd);
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err(), "listener closed");
    }

    #[tokio::test]
    async fn upstream_failure_closes_the_local_connection() {
        let dial: Dial = Arc::new(|| Box::pin(async { Err(Error::Ssh("unreachable".into())) }));
        let fwd = Forwarder::start(dial).await.unwrap();
        let mut c = tokio::net::TcpStream::connect(("127.0.0.1", fwd.local_port)).await.unwrap();
        let mut buf = [0u8; 1];
        assert_eq!(c.read(&mut buf).await.unwrap(), 0, "closed without data");
    }
}
