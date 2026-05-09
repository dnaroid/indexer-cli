#[derive(Debug)]
pub enum AppError {
    Unauthorized,
    Storage(String),
}
