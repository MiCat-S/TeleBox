#[test]
fn high_level_client_is_available() {
    // Compile the actual candidate, not a replacement protocol implementation.
    assert!(std::mem::size_of::<grammers_client::Client>() > 0);
}

#[test]
fn required_rpc_serialization() {
    use grammers_tl_types::{Serializable, enums::InputPeer, functions};
    let requests = [
        functions::messages::GetHistory {
            peer: InputPeer::PeerSelf, offset_id: 0, offset_date: 0,
            add_offset: 0, limit: 10, max_id: 0, min_id: 0, hash: 0,
        }.to_bytes(),
        functions::messages::EditMessage {
            no_webpage: false, invert_media: false, peer: InputPeer::PeerSelf,
            id: 1, message: Some("synthetic".into()), media: None,
            reply_markup: None, entities: None, schedule_date: None,
            schedule_repeat_period: None, quick_reply_shortcut_id: None,
            rich_message: None,
        }.to_bytes(),
        functions::messages::DeleteMessages {revoke: false, id: vec![1]}.to_bytes(),
        functions::channels::GetSendAs {
            for_paid_reactions: false, for_live_stories: false, peer: InputPeer::PeerSelf,
        }.to_bytes(),
        functions::messages::GetBotCallbackAnswer {
            game: false, peer: InputPeer::PeerSelf, msg_id: 1,
            data: Some(vec![0, 255]), password: None,
        }.to_bytes(),
        functions::upload::SaveFilePart {file_id: 1, file_part: 0, bytes: b"synthetic".to_vec()}.to_bytes(),
        functions::updates::GetState {}.to_bytes(),
    ];
    for bytes in requests {assert!(bytes.len() >= 4);}
}

#[test]
fn callback_binary_round_trip() {
    use grammers_tl_types::{Deserializable, Serializable, enums, types};
    let callback = enums::KeyboardButton::Callback(types::KeyboardButtonCallback {
        requires_password: false, style: None, text: "callback".into(), data: vec![0, 255, 1],
    });
    let encoded = callback.to_bytes();
    assert_eq!(enums::KeyboardButton::from_bytes(&encoded).unwrap(), callback);
    assert!(enums::KeyboardButton::from_bytes(&encoded[..4]).is_err());
    assert_eq!(grammers_tl_types::LAYER, 227);
}

#[test]
fn current_teleproto_session_fields_import() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use grammers_session::{Session, SessionData, storages::MemorySession};
    use std::{net::{IpAddr, SocketAddrV4, SocketAddrV6}, path::Path, process::Command};

    let generator = Path::new(env!("CARGO_MANIFEST_DIR")).join("../synthetic-session.cjs");
    let output = Command::new("node").arg(generator).output().unwrap();
    assert!(output.status.success());
    let fixtures: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(fixtures["synthetic"], true);
    let cases = fixtures["fixtures"].as_array().unwrap();
    assert_eq!(cases.len(), 2);
    for case in cases {
        let encoded = case["teleproto"].as_str().unwrap();
        assert!(encoded.starts_with('1'));
        let bytes = STANDARD.decode(&encoded[1..]).unwrap();
        let size = u16::from_be_bytes([bytes[1], bytes[2]]) as usize;
        assert_eq!(bytes.len(), 5 + size + 256);
        let address = std::str::from_utf8(&bytes[3..3 + size]).unwrap();
        let port = u16::from_be_bytes([bytes[3 + size], bytes[4 + size]]);
        let key: [u8; 256] = bytes[5 + size..].try_into().unwrap();
        assert_eq!(key, [0xa5; 256]);
        assert_eq!(address, case["address"].as_str().unwrap());
        assert_eq!(port as u64, case["port"].as_u64().unwrap());
        let dc = bytes[0] as i32;
        assert_eq!(dc as i64, case["dc"].as_i64().unwrap());
        let ip: IpAddr = address.parse().unwrap();
        let mut data = SessionData::default();
        data.home_dc = dc;
        let option = data.dc_options.get_mut(&dc).unwrap();
        option.auth_key = Some(key);
        match ip {
            IpAddr::V4(ip) => option.ipv4 = SocketAddrV4::new(ip, port),
            IpAddr::V6(ip) => option.ipv6 = SocketAddrV6::new(ip, port, 0, 0),
        }
        let session = MemorySession::from(data);
        assert_eq!(session.home_dc_id().unwrap(), dc);
        let restored = session.dc_option(dc).unwrap().unwrap();
        assert_eq!(restored.auth_key.unwrap(), key);
        match ip {
            IpAddr::V4(_) => assert_eq!(restored.ipv4.to_string(), format!("{address}:{port}")),
            IpAddr::V6(_) => assert_eq!(restored.ipv6.to_string(), format!("[{address}]:{port}")),
        }
    }
}
