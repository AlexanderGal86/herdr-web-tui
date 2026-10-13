use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use time::OffsetDateTime;
use x509_parser::prelude::FromDer as _;

pub(crate) fn default_tls_state_dir() -> PathBuf {
    if let Some(path) = crate::store_util::non_empty_env_path("HERDR_WEB_TLS_DIR") {
        return path;
    }
    if let Some(state_home) = crate::store_util::non_empty_env_path("XDG_STATE_HOME") {
        return state_home.join("herdr-web").join("tls");
    }
    if let Some(home) = crate::store_util::non_empty_env_path("HOME") {
        return home
            .join(".local")
            .join("state")
            .join("herdr-web")
            .join("tls");
    }
    PathBuf::from("herdr-web-tls")
}

pub(crate) fn host_san_entries() -> Vec<String> {
    let hostname = os_hostname();
    let fqdn = fqdn_for_hostname(hostname.as_deref());
    let ips = interface_ips();
    san_entry_set(hostname.as_deref().unwrap_or(""), fqdn.as_deref(), &ips)
}

fn san_entry_set(hostname: &str, fqdn: Option<&str>, ips: &[IpAddr]) -> Vec<String> {
    let mut entries: Vec<String> = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    let push_unique = |entries: &mut Vec<String>, value: String| {
        if !entries
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(&value))
        {
            entries.push(value);
        }
    };
    for name in [Some(hostname), fqdn].into_iter().flatten() {
        let name = name.to_ascii_lowercase();
        if crate::web_bridge::is_valid_dns_hostname(&name) {
            push_unique(&mut entries, name);
        }
    }
    let mut suitable: Vec<IpAddr> = ips
        .iter()
        .copied()
        .filter(|ip| is_suitable_san_ip(*ip))
        .collect();
    suitable.sort();
    suitable.dedup();
    for ip in suitable {
        push_unique(&mut entries, ip.to_string());
    }
    entries
}

fn is_suitable_san_ip(ip: IpAddr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    match ip {
        IpAddr::V4(v4) => !v4.is_link_local() && !v4.is_broadcast() && !v4.is_documentation(),
        // v6 link-local fe80::/10 has no stable std helper yet
        IpAddr::V6(v6) => v6.segments()[0] & 0xffc0 != 0xfe80,
    }
}

#[cfg(unix)]
fn os_hostname() -> Option<String> {
    use std::os::unix::ffi::OsStringExt;
    let mut buffer = [0u8; 256];
    let status =
        unsafe { libc::gethostname(buffer.as_mut_ptr() as *mut libc::c_char, buffer.len()) };
    if status != 0 {
        return None;
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    std::ffi::OsString::from_vec(buffer[..end].to_vec())
        .into_string()
        .ok()
}

#[cfg(unix)]
fn fqdn_for_hostname(hostname: Option<&str>) -> Option<String> {
    use std::ptr;
    let hostname = hostname?;
    let mut hints: libc::addrinfo = unsafe { std::mem::zeroed() };
    hints.ai_flags = libc::AI_CANONNAME;
    let c_hostname = std::ffi::CString::new(hostname).ok()?;
    let mut result: *mut libc::addrinfo = ptr::null_mut();
    let status =
        unsafe { libc::getaddrinfo(c_hostname.as_ptr(), ptr::null(), &hints, &mut result) };
    if status != 0 {
        return None;
    }
    let canon = unsafe { (*result).ai_canonname };
    let fqdn = if canon.is_null() {
        None
    } else {
        unsafe { std::ffi::CStr::from_ptr(canon) }
            .to_str()
            .ok()
            .map(str::to_string)
    };
    unsafe { libc::freeaddrinfo(result) };
    fqdn
}

#[cfg(unix)]
fn interface_ips() -> Vec<IpAddr> {
    use std::ptr;
    let mut ips = Vec::new();
    let mut ifap: *mut libc::ifaddrs = ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut ifap) } != 0 {
        return ips;
    }
    let mut cursor = ifap;
    while !cursor.is_null() {
        let ifa = unsafe { &*cursor };
        let addr = ifa.ifa_addr;
        if !addr.is_null() {
            let family = unsafe { (*addr).sa_family } as i32;
            match family {
                libc::AF_INET => {
                    let sockaddr = unsafe { &*(addr as *const libc::sockaddr_in) };
                    ips.push(IpAddr::V4(std::net::Ipv4Addr::from(
                        sockaddr.sin_addr.s_addr.to_ne_bytes(),
                    )));
                }
                libc::AF_INET6 => {
                    let sockaddr = unsafe { &*(addr as *const libc::sockaddr_in6) };
                    ips.push(IpAddr::V6(std::net::Ipv6Addr::from(
                        sockaddr.sin6_addr.s6_addr,
                    )));
                }
                _ => {}
            }
        }
        cursor = ifa.ifa_next;
    }
    unsafe { libc::freeifaddrs(ifap) };
    ips
}

// shortcut: windows hostname/FQDN come from env (COMPUTERNAME/USERDNSDOMAIN);
// cross-check on a real Windows host before shipping a Windows build
#[cfg(windows)]
fn os_hostname() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(windows)]
fn fqdn_for_hostname(hostname: Option<&str>) -> Option<String> {
    let hostname = hostname?;
    let domain = std::env::var("USERDNSDOMAIN").ok()?;
    Some(format!("{hostname}.{domain}"))
}

#[cfg(windows)]
fn interface_ips() -> Vec<IpAddr> {
    use std::ptr;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::Networking::WinSock::{
        AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6,
    };

    const FLAGS: u32 = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 16 * 1024;
    let mut buffer = vec![0u8; size as usize];
    loop {
        let status = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                FLAGS,
                ptr::null_mut(),
                buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut size,
            )
        };
        if status == ERROR_SUCCESS {
            break;
        }
        if size as usize > buffer.len() {
            buffer = vec![0u8; size as usize];
            continue;
        }
        return Vec::new();
    }
    let mut ips = Vec::new();
    let mut adapter = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !adapter.is_null() {
        let adapter_ref = unsafe { &*adapter };
        let mut entry = adapter_ref.FirstUnicastAddress;
        while !entry.is_null() {
            let entry_ref = unsafe { &*entry };
            let sockaddr = entry_ref.Address.lpSockaddr as *const SOCKADDR;
            if !sockaddr.is_null() {
                let family = unsafe { (*sockaddr).sa_family };
                if family == AF_INET as u16 {
                    let v4 = unsafe { &*(sockaddr as *const SOCKADDR_IN) };
                    ips.push(IpAddr::V4(std::net::Ipv4Addr::from(unsafe {
                        v4.sin_addr.S_un.S_addr
                    })));
                } else if family == AF_INET6 as u16 {
                    let v6 = unsafe { &*(sockaddr as *const SOCKADDR_IN6) };
                    ips.push(IpAddr::V6(std::net::Ipv6Addr::from(unsafe {
                        v6.sin6_addr.u.Byte
                    })));
                }
            }
            entry = entry_ref.Next;
        }
        adapter = adapter_ref.Next;
    }
    ips
}

// --- Certificate lifecycle (t3) -------------------------------------------

pub(crate) struct SelfSignedCertificate {
    pub cert_pem: String,
    pub key_pem: String,
    pub cert_der: Vec<u8>,
}

pub(crate) const CERT_FILE: &str = "self-signed.crt.pem";
pub(crate) const KEY_FILE: &str = "self-signed.key.pem";

pub(crate) fn load_or_generate_self_signed(
    dir: &Path,
    now: OffsetDateTime,
) -> std::io::Result<SelfSignedCertificate> {
    if let Some(existing) = read_valid_pair(dir, now) {
        return Ok(existing);
    }
    tracing::warn!(
        dir = %dir.display(),
        "TLS certificate missing or invalid; regenerating self-signed certificate"
    );
    let sans = host_san_entries();
    let pair = generate_with_validity(
        &sans,
        now - time::Duration::hours(24),
        now + time::Duration::days(5 * 365),
    )?;
    persist_pair(dir, &pair)?;
    Ok(pair)
}

fn read_valid_pair(dir: &Path, now: OffsetDateTime) -> Option<SelfSignedCertificate> {
    let cert_pem = std::fs::read_to_string(dir.join(CERT_FILE)).ok()?;
    let key_pem = std::fs::read_to_string(dir.join(KEY_FILE)).ok()?;
    let cert_der = pem_certificate_der(&cert_pem)?;
    pem_private_key(&key_pem)?;
    let (_, cert) = x509_parser::prelude::X509Certificate::from_der(&cert_der).ok()?;
    let validity = cert.validity();
    if now < validity.not_before.to_datetime() || now > validity.not_after.to_datetime() {
        return None;
    }
    Some(SelfSignedCertificate {
        cert_pem,
        key_pem,
        cert_der,
    })
}

fn pem_certificate_der(cert_pem: &str) -> Option<Vec<u8>> {
    let mut cursor = std::io::BufReader::new(cert_pem.as_bytes());
    let certificate = rustls_pemfile::certs(&mut cursor).next()?.ok()?;
    Some(certificate.as_ref().to_vec())
}

fn pem_private_key(key_pem: &str) -> Option<()> {
    let mut cursor = std::io::BufReader::new(key_pem.as_bytes());
    rustls_pemfile::private_key(&mut cursor).ok().flatten()?;
    Some(())
}

fn generate_with_validity(
    sans: &[String],
    not_before: OffsetDateTime,
    not_after: OffsetDateTime,
) -> std::io::Result<SelfSignedCertificate> {
    let mut params = rcgen::CertificateParams::new(sans.to_vec())
        .map_err(|err| std::io::Error::other(format!("certificate params: {err}")))?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "herdr-web-bridge");
    params.not_before = not_before;
    params.not_after = not_after;
    let key_pair = rcgen::KeyPair::generate()
        .map_err(|err| std::io::Error::other(format!("key generation: {err}")))?;
    let certificate = params
        .self_signed(&key_pair)
        .map_err(|err| std::io::Error::other(format!("self-signing: {err}")))?;
    Ok(SelfSignedCertificate {
        cert_pem: certificate.pem(),
        key_pem: key_pair.serialize_pem(),
        cert_der: certificate.der().as_ref().to_vec(),
    })
}

fn persist_pair(dir: &Path, pair: &SelfSignedCertificate) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(err) => return Err(err),
    }
    write_atomic(dir.join(CERT_FILE), pair.cert_pem.as_bytes(), 0o644)?;
    write_atomic(dir.join(KEY_FILE), pair.key_pem.as_bytes(), 0o600)
}

fn write_atomic(path: std::path::PathBuf, contents: &[u8], unix_mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or(Path::new("."));
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let temp = dir.join(format!(".tmp-{file_name}"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(unix_mode);
    }
    {
        let mut file = options.open(&temp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    // unix rename() replaces an existing target atomically
    std::fs::rename(&temp, &path)
}

pub(crate) fn certificate_san_entries(cert_der: &[u8]) -> Vec<String> {
    let Ok((_, cert)) = x509_parser::prelude::X509Certificate::from_der(cert_der) else {
        return Vec::new();
    };
    let Ok(Some(extension)) = cert.subject_alternative_name() else {
        return Vec::new();
    };
    extension
        .value
        .general_names
        .iter()
        .filter_map(|name| match name {
            x509_parser::extensions::GeneralName::DNSName(dns) => Some(dns.to_string()),
            x509_parser::extensions::GeneralName::IPAddress(octets) => match octets.len() {
                4 => {
                    let mut bytes = [0u8; 4];
                    bytes.copy_from_slice(&octets[..4]);
                    Some(IpAddr::V4(std::net::Ipv4Addr::from(bytes)).to_string())
                }
                16 => {
                    let mut bytes = [0u8; 16];
                    bytes.copy_from_slice(&octets[..16]);
                    Some(IpAddr::V6(std::net::Ipv6Addr::from(bytes)).to_string())
                }
                _ => None,
            },
            _ => None,
        })
        .collect()
}

pub(crate) fn missing_san_entries(current: &[String], cert_sans: &[String]) -> Vec<String> {
    current
        .iter()
        .filter(|entry| {
            !cert_sans
                .iter()
                .any(|san| san.eq_ignore_ascii_case(entry.as_str()))
        })
        .cloned()
        .collect()
}

pub(crate) fn cert_sha256_fingerprint(cert_der: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(cert_der);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn san_drift_warnings(current_sans: &[String], cert_der: &[u8]) -> Vec<String> {
    let cert_sans = certificate_san_entries(cert_der);
    let missing = missing_san_entries(current_sans, &cert_sans);
    if missing.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "served certificate is missing SANs: {} (keeping the persisted certificate; regenerate manually if needed)",
            missing.join(", ")
        )]
    }
}

pub(crate) fn server_config(
    pair: &SelfSignedCertificate,
) -> std::io::Result<Arc<rustls::ServerConfig>> {
    let certificates = vec![rustls::pki_types::CertificateDer::from(
        pair.cert_der.clone(),
    )];
    let mut key_reader = pair.key_pem.as_bytes();
    let private_key = rustls_pemfile::private_key(&mut key_reader)?
        .ok_or_else(|| std::io::Error::other("TLS private key missing from key PEM"))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|err| std::io::Error::other(format!("TLS protocol versions: {err}")))?
        .with_no_client_auth()
        .with_single_cert(certificates, private_key)
        .map_err(|err| std::io::Error::other(format!("TLS certificate pair: {err}")))?;
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tls_state_dir_env_precedence() {
        let _guard = crate::session::TEST_ENV_LOCK.lock().unwrap();
        let keys = ["HERDR_WEB_TLS_DIR", "XDG_STATE_HOME", "HOME"];
        let saved: Vec<(&str, Option<String>)> = keys
            .iter()
            .map(|key| (*key, std::env::var(key).ok()))
            .collect();

        std::env::remove_var("XDG_STATE_HOME");
        std::env::remove_var("HOME");
        std::env::set_var("HERDR_WEB_TLS_DIR", "/tmp/custom-tls");
        assert_eq!(default_tls_state_dir(), PathBuf::from("/tmp/custom-tls"));

        std::env::remove_var("HERDR_WEB_TLS_DIR");
        std::env::set_var("XDG_STATE_HOME", "/tmp/xdg-state");
        assert_eq!(
            default_tls_state_dir(),
            PathBuf::from("/tmp/xdg-state/herdr-web/tls")
        );

        std::env::remove_var("XDG_STATE_HOME");
        std::env::set_var("HOME", "/tmp/tls-home");
        assert_eq!(
            default_tls_state_dir(),
            PathBuf::from("/tmp/tls-home/.local/state/herdr-web/tls")
        );

        std::env::remove_var("HOME");
        assert_eq!(default_tls_state_dir(), PathBuf::from("herdr-web-tls"));

        for (key, value) in saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    #[test]
    fn san_entries_cover_base_hostname_and_suitable_ips() {
        let ips = vec![
            IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 5)),
            IpAddr::V4(std::net::Ipv4Addr::new(169, 254, 1, 1)), // link-local: skipped
            IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 2)),   // extra loopback: skipped
            IpAddr::V6("fe80::1".parse().unwrap()),              // v6 link-local: skipped
            IpAddr::V6("fd00::10".parse().unwrap()),             // private v6: kept
        ];
        let entries = san_entry_set("workstation", Some("workstation.lan"), &ips);
        assert_eq!(
            entries,
            vec![
                "localhost".to_string(),
                "127.0.0.1".to_string(),
                "::1".to_string(),
                "workstation".to_string(),
                "workstation.lan".to_string(),
                "192.168.1.5".to_string(),
                "fd00::10".to_string(),
            ]
        );
    }

    #[test]
    fn san_entries_skip_invalid_hostnames_and_dedup() {
        let entries = san_entry_set("bad_host", Some("BAD_host"), &[]);
        assert_eq!(
            entries,
            vec![
                "localhost".to_string(),
                "127.0.0.1".to_string(),
                "::1".to_string(),
            ]
        );
    }

    // --- t3 lifecycle tests -------------------------------------------------

    fn fixed_now() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_760_000_000).unwrap()
    }

    fn temp_tls_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("herdr-tls-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const TEST_SANS: &[&str] = &["localhost", "127.0.0.1", "::1", "192.168.1.5"];

    #[test]
    fn reuse_identity_stable_across_calls() {
        let dir = temp_tls_dir("reuse");
        let now = fixed_now();
        let first = load_or_generate_self_signed(&dir, now).unwrap();
        let second = load_or_generate_self_signed(&dir, now).unwrap();
        assert_eq!(first.cert_pem, second.cert_pem);
        assert_eq!(first.key_pem, second.key_pem);
        assert_eq!(first.cert_der, second.cert_der);
    }

    #[test]
    fn corrupt_cert_file_regenerates() {
        let dir = temp_tls_dir("corrupt-cert");
        let now = fixed_now();
        let first = load_or_generate_self_signed(&dir, now).unwrap();
        std::fs::write(dir.join(CERT_FILE), "this is not a certificate").unwrap();
        let second = load_or_generate_self_signed(&dir, now).unwrap();
        assert_ne!(first.cert_pem, second.cert_pem);
    }

    #[test]
    fn truncated_key_file_regenerates() {
        let dir = temp_tls_dir("truncated-key");
        let now = fixed_now();
        let first = load_or_generate_self_signed(&dir, now).unwrap();
        let truncated: String = first.key_pem.chars().take(40).collect();
        std::fs::write(dir.join(KEY_FILE), truncated).unwrap();
        let second = load_or_generate_self_signed(&dir, now).unwrap();
        assert_ne!(first.key_pem, second.key_pem);
    }

    #[test]
    fn expired_cert_regenerates() {
        let dir = temp_tls_dir("expired");
        let now = fixed_now();
        let expired = generate_with_validity(
            &TEST_SANS.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            now - time::Duration::days(10 * 365),
            now - time::Duration::days(5 * 365),
        )
        .unwrap();
        std::fs::write(dir.join(CERT_FILE), &expired.cert_pem).unwrap();
        std::fs::write(dir.join(KEY_FILE), &expired.key_pem).unwrap();
        let fresh = load_or_generate_self_signed(&dir, now).unwrap();
        assert_ne!(expired.cert_pem, fresh.cert_pem);
        // fresh pair must be valid at `now` and persist as the new identity
        let reread = load_or_generate_self_signed(&dir, now).unwrap();
        assert_eq!(fresh.cert_pem, reread.cert_pem);
    }

    #[test]
    fn san_roundtrip_and_missing_diff() {
        let sans: Vec<String> = TEST_SANS.iter().map(|s| s.to_string()).collect();
        let pair =
            generate_with_validity(&sans, fixed_now(), fixed_now() + time::Duration::days(1))
                .unwrap();
        let parsed = certificate_san_entries(&pair.cert_der);
        for san in &sans {
            assert!(parsed.contains(san), "missing SAN {san} in {parsed:?}");
        }
        let mut drifted = sans.clone();
        drifted.push("10.0.0.9".to_string());
        assert_eq!(missing_san_entries(&drifted, &parsed), vec!["10.0.0.9"]);
        assert!(missing_san_entries(&sans, &parsed).is_empty());
    }

    #[test]
    fn server_config_builds_from_fresh_pair() {
        let sans: Vec<String> = TEST_SANS.iter().map(|s| s.to_string()).collect();
        let pair =
            generate_with_validity(&sans, fixed_now(), fixed_now() + time::Duration::days(1))
                .unwrap();
        assert_eq!(pem_certificate_der(&pair.cert_pem).unwrap(), pair.cert_der);
        let config = server_config(&pair).unwrap();
        assert!(format!("{config:?}").contains("ServerConfig"));
    }

    #[test]
    fn san_drift_warning_lists_missing_entries() {
        let sans: Vec<String> = TEST_SANS.iter().map(|s| s.to_string()).collect();
        let pair =
            generate_with_validity(&sans, fixed_now(), fixed_now() + time::Duration::days(1))
                .unwrap();
        let mut current = sans.clone();
        current.push("10.0.0.9".to_string());
        let warnings = san_drift_warnings(&current, &pair.cert_der);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("10.0.0.9"), "got {warnings:?}");
        assert!(san_drift_warnings(&sans, &pair.cert_der).is_empty());
    }

    #[test]
    fn san_drift_does_not_regenerate_valid_cert() {
        let dir = temp_tls_dir("drift");
        let sans: Vec<String> = TEST_SANS.iter().map(|s| s.to_string()).collect();
        let pair =
            generate_with_validity(&sans, fixed_now(), fixed_now() + time::Duration::days(1))
                .unwrap();
        std::fs::write(dir.join(CERT_FILE), &pair.cert_pem).unwrap();
        std::fs::write(dir.join(KEY_FILE), &pair.key_pem).unwrap();
        let drifted = ["10.0.0.9".to_string()];
        assert!(!san_drift_warnings(&drifted, &pair.cert_der).is_empty());
        let reloaded = load_or_generate_self_signed(&dir, fixed_now()).unwrap();
        assert_eq!(reloaded.cert_pem, pair.cert_pem);
    }

    #[test]
    fn fingerprint_is_stable_hex_and_differs_per_cert() {
        let sans: Vec<String> = TEST_SANS.iter().map(|s| s.to_string()).collect();
        let one = generate_with_validity(&sans, fixed_now(), fixed_now() + time::Duration::days(1))
            .unwrap();
        let two = generate_with_validity(&sans, fixed_now(), fixed_now() + time::Duration::days(1))
            .unwrap();
        let fp_one = cert_sha256_fingerprint(&one.cert_der);
        assert_eq!(fp_one, cert_sha256_fingerprint(&one.cert_der));
        assert_eq!(fp_one.len(), 64);
        assert!(fp_one.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(fp_one, cert_sha256_fingerprint(&two.cert_der));
    }
}
