use std::collections::VecDeque;

/// Ring buffer for scrollback history per session (default 2 MiB).
pub struct ScrollbackRingBuffer {
    capacity: usize,
    buffer: VecDeque<u8>,
    total_bytes_written: usize,
}

impl ScrollbackRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            buffer: VecDeque::with_capacity(capacity.min(65536)),
            total_bytes_written: 0,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.total_bytes_written += chunk.len();

        if chunk.len() >= self.capacity {
            self.buffer.clear();
            let start = chunk.len() - self.capacity;
            self.buffer.extend(&chunk[start..]);
            return;
        }

        let overflow = (self.buffer.len() + chunk.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.buffer.drain(..overflow);
        }
        self.buffer.extend(chunk);
    }

    pub fn to_vec(&self) -> Vec<u8> {
        let (first, second) = self.buffer.as_slices();
        let mut out = Vec::with_capacity(self.buffer.len());
        out.extend_from_slice(first);
        out.extend_from_slice(second);
        out
    }

    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    pub fn total_bytes_written(&self) -> usize {
        self.total_bytes_written
    }

    /// Returns replay bytes starting from `from_seq`, and whether data was truncated.
    pub fn get_since(&self, from_seq: usize) -> (Vec<u8>, bool) {
        let oldest_seq = self.total_bytes_written.saturating_sub(self.buffer.len());
        let truncated = from_seq < oldest_seq;
        let offset = if from_seq < oldest_seq {
            0
        } else {
            (from_seq - oldest_seq).min(self.buffer.len())
        };

        let (first, second) = self.buffer.as_slices();
        let mut out = Vec::with_capacity(self.buffer.len() - offset);
        if offset < first.len() {
            out.extend_from_slice(&first[offset..]);
            out.extend_from_slice(second);
        } else {
            let second_offset = offset - first.len();
            out.extend_from_slice(&second[second_offset..]);
        }
        (out, truncated)
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
    }
}
