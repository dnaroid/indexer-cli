//! Rust fixture library for parser tests.

use crate::{errors::AppError, services::auth::AuthService};
use std::collections::HashMap;

mod errors;
pub mod services;

/// User order aggregate.
#[derive(Debug)]
pub struct Order {
	id: u64,
}

pub enum Status {
	Pending,
	Done,
}

pub trait Repository {
	fn save(&self, order: &Order) -> Result<(), AppError>;
}

impl Order {
	pub fn new(id: u64) -> Self {
		Self { id }
	}
}

pub async fn run(auth: AuthService) -> anyhow::Result<HashMap<u64, Order>> {
	let _ = auth;
	Ok(HashMap::new())
}
