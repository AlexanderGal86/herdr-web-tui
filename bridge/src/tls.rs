use std::net::IpAddr;
use std::path::PathBuf;

pub(crate) fn default_tls_state_dir() -> PathBuf {
    todo!("t2: HERDR_WEB_TLS_DIR > XDG_STATE_HOME > HOME > ./herdr-web-tls")
}

pub(crate) fn host_san_entries() -> Vec<String> {
    todo!("t2: gather hostname (+FQDN) and non-loopback/non-link-local interface IPs")
}

fn san_entry_set(hostname: &str, fqdn: Option<&str>, ips: &[IpAddr]) -> Vec<String> {
    todo!("t2: localhost + loopbacks + hostname + fqdn + suitable IPs, deduped")
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
            IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 2)), // extra loopback: skipped
            IpAddr::V6("fe80::1".parse().unwrap()),             // v6 link-local: skipped
            IpAddr::V6("fd00::10".parse().unwrap()),            // private v6: kept
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
}
