use crate::errors::AppError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: u64,
    pub owner_token: String,
}

pub trait OrderRepository {
    fn save(&self, order: &Order) -> Result<(), AppError>;
}

impl Order {
    pub fn new(id: u64, owner_token: impl Into<String>) -> Self {
        Self {
            id,
            owner_token: owner_token.into(),
        }
    }
}
