//! TLS for database connections: rustls with the `ring` provider.
//!
//! `prefer` / `require` encrypt but do not check the certificate (like libpq);
//! `verify-full` checks it against the system roots plus an optional CA file.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};

use crate::{Error, Result};

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Client config. `verify` = check the certificate chain and host name.
pub fn client_config(verify: bool, ca_path: Option<&str>) -> Result<ClientConfig> {
    let p = provider();
    let builder = ClientConfig::builder_with_provider(p.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::Other(format!("TLS: {e}")))?;
    if !verify {
        return Ok(builder.dangerous().with_custom_certificate_verifier(Arc::new(NoVerify(p))).with_no_client_auth());
    }
    let mut roots = RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    roots.add_parsable_certificates(native.certs);
    if let Some(path) = ca_path {
        let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(path)
            .map_err(|e| Error::Other(format!("CA file {path}: {e}")))?
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| Error::Other(format!("CA file {path}: {e}")))?;
        if certs.is_empty() {
            return Err(Error::Other(format!("CA file {path} has no certificates")));
        }
        roots.add_parsable_certificates(certs);
    }
    if roots.is_empty() {
        return Err(Error::Other("no trusted certificates found; add a CA file".into()));
    }
    Ok(builder.with_root_certificates(roots).with_no_client_auth())
}

/// Encrypts without checking who is on the other end (`prefer` / `require`).
#[derive(Debug)]
struct NoVerify(Arc<CryptoProvider>);

impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configs_build_without_a_process_default_provider() {
        assert!(client_config(false, None).is_ok());
        assert!(client_config(true, Some("does-not-exist.pem")).is_err());
    }
}
