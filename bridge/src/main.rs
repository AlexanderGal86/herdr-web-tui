mod agent_activity;
mod agent_pins;
mod launcher_presets;
mod machines;
mod notes;
mod remote_uploads;
mod session;
mod store_util;
mod tls;
mod web_bridge;
mod websocket_heartbeat;
mod workspace;
mod workspace_zones;

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(web_bridge::run_command(&args)?);
}
