/// Percent-decode a URL-encoded string (%XX → UTF-8 bytes).
/// Handles full RFC 3986 encoding including multi-byte UTF-8 sequences (Korean etc.).
pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_encoded() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
    }

    #[test]
    fn korean_path() {
        // "이미지" percent-encoded in UTF-8
        assert_eq!(
            percent_decode("%EC%9D%B4%EB%AF%B8%EC%A7%80"),
            "이미지"
        );
    }

    #[test]
    fn mixed_path() {
        assert_eq!(
            percent_decode("./assets/%EC%82%AC%EC%A7%84%20test.png"),
            "./assets/사진 test.png"
        );
    }

    #[test]
    fn no_encoding() {
        assert_eq!(percent_decode("plain.png"), "plain.png");
    }

    #[test]
    fn incomplete_percent_kept() {
        assert_eq!(percent_decode("a%2"), "a%2");
    }
}
