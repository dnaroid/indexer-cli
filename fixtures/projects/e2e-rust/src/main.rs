use crate::services::auth::AuthService;

mod errors;
mod services;

fn main() -> anyhow::Result<()> {
	let auth = AuthService::new("local");
	if auth.verify("token") {
		println!("authenticated");
	}
	Ok(())
}
