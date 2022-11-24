use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    io::{stdout, Write},
    path::PathBuf,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::client_daemon::CONTROL_SOCKET_PATH;
use crate::service_description::ServiceDescription;

/// Start the given stopped service
///
/// Running services will be restarted on reboot
#[derive(clap::Parser, Serialize, Deserialize)]
pub struct Start {
    /// Name of the service to start
    pub service: String,
}

/// Stop the given running service
///
/// Stopped services will not be started on reboot
#[derive(clap::Parser, Serialize, Deserialize)]
pub struct Stop {
    /// Name of the service to stop
    pub service: String,
}

/// Restart the given running service
#[derive(clap::Parser, Serialize, Deserialize)]
pub struct Restart {
    /// Name of the service to restart
    pub service: String,
}

#[derive(clap::ValueEnum, Clone, Serialize, Deserialize)]
pub enum Porcelain {
    V1,
}

/// Print information about all or a specific service
#[derive(clap::Parser, Serialize, Deserialize)]
pub struct Status {
    /// Name of the service to get status of
    pub service: Option<String>,

    /// Give the output in an easy-to-parse format for scripts
    #[clap(value_enum, long)]
    pub porcelain: Option<Porcelain>,
}

/// Remove service
///
/// Stop and remove a given service, it will
/// have to be redeployed to be recreated
#[derive(clap::Parser, Serialize, Deserialize)]
pub struct Remove {
    /// Name of the service to remove
    pub service: String,
}

/// Deploy a new service locally
///
/// Normally a service is deployed though `sadmin service-deploy` but
/// if no information needs to be templated into the description.
/// It can also be deployed locally through this command
#[derive(clap::Parser)]
pub struct Deploy {
    /// Path to the service description yaml file
    description: PathBuf,
    /// Docker image to use for deployment
    image: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct DeployMsg {
    pub image: Option<String>,
    pub config: Box<ServiceDescription>,
}

#[derive(clap::Subcommand)]
pub enum Action {
    Start(Start),
    Stop(Stop),
    Restart(Restart),
    Status(Status),
    Remove(Remove),
    Deploy(Deploy),
    /// Stop all services without storing the stopped state, in preparation for machine shutdown
    Shutdown,
}

/// Query or manipulate services running on this host (root)
#[derive(clap::Parser)]
pub struct Service {
    #[clap(subcommand)]
    action: Action,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DaemonControlMessage {
    Start(Start),
    Stop(Stop),
    Restart(Restart),
    Status(Status),
    Remove(Remove),
    Deploy(DeployMsg),
    Stdout { data: String }, // Base 64 encoded bytes
    Stderr { data: String }, // Base 64 encoded bytes
    Finished { code: i32 },
    Shutdown,
}

#[allow(clippy::read_zero_byte_vec)]
pub async fn run(args: Service) -> Result<()> {
    let msg = match args.action {
        Action::Start(v) => DaemonControlMessage::Start(v),
        Action::Stop(v) => DaemonControlMessage::Stop(v),
        Action::Restart(v) => DaemonControlMessage::Restart(v),
        Action::Status(v) => DaemonControlMessage::Status(v),
        Action::Remove(v) => DaemonControlMessage::Remove(v),
        Action::Shutdown => DaemonControlMessage::Shutdown,
        Action::Deploy(v) => {
            let config =
                std::fs::read_to_string(v.description).context("Unable to read config file")?;
            let config: ServiceDescription =
                serde_yaml::from_str(&config).context("Unable to parse config file")?;
            DaemonControlMessage::Deploy(DeployMsg {
                image: v.image,
                config: Box::new(config),
            })
        }
    };
    let msg = serde_json::to_vec(&msg)?;
    let mut socket = tokio::net::UnixStream::connect(CONTROL_SOCKET_PATH)
        .await
        .with_context(|| format!("Connecting to client daemon at {}", CONTROL_SOCKET_PATH))?;
    socket.write_u32(msg.len().try_into()?).await?;
    socket.write_all(&msg).await?;
    let mut buf = Vec::new();
    loop {
        let len = socket.read_u32().await?;
        buf.resize(len.try_into()?, 0);
        socket.read_exact(&mut buf).await?;
        let msg: DaemonControlMessage = serde_json::from_slice(&buf)?;
        match msg {
            DaemonControlMessage::Stdout { data } => {
                let mut o = stdout().lock();
                o.write_all(&base64::decode(data)?)?;
                o.flush()?;
            }
            DaemonControlMessage::Stderr { data } => {
                let mut o = stdout().lock();
                o.write_all(&base64::decode(data)?)?;
                o.flush()?;
            }
            DaemonControlMessage::Finished { code } => {
                std::process::exit(code);
            }
            _ => {}
        }
    }
}