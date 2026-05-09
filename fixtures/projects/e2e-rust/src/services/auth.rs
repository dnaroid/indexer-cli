use super::order::Order;

#[derive(Debug, Clone)]
pub struct AuthService {
    issuer: String,
}

impl AuthService {
    pub fn new(issuer: impl Into<String>) -> Self {
        Self {
            issuer: issuer.into(),
        }
    }

    pub fn verify(&self, token: &str) -> bool {
        !self.issuer.is_empty() && !token.is_empty()
    }

    pub fn can_access(&self, order: &Order) -> bool {
        self.verify(&order.owner_token)
    }
}
