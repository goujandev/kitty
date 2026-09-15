//! Windows job objects: the one mechanism kitty uses to kill a process tree.
//!
//! An agent CLI is rarely one process. `claude` is an npm shim that launches
//! Node, which spawns its own children. Killing the process we started leaves
//! the rest running, which is how `MonoCode` ended up with an orphan sweep at
//! launch and two separate kill implementations that have already drifted
//! (ADR-0001).
//!
//! A job object solves this properly. Every child goes into one, the job has
//! `KILL_ON_JOB_CLOSE`, and dropping the handle takes the whole tree with it,
//! including descendants spawned after us. There is no signal ladder and no
//! `taskkill`.
//!
//! ## The assignment race, stated honestly
//!
//! The airtight form assigns the job during `CreateProcessW` itself via
//! `PROC_THREAD_ATTRIBUTE_JOB_LIST`, so a child cannot spawn anything before
//! it is contained. `std::process::Command` does not expose the attribute
//! list, which is exactly why `MonoCode` vendored and patched `portable-pty`.
//!
//! We assign immediately after spawn instead. The gap is the microseconds
//! between `CreateProcessW` returning and our next call, during which a child
//! would have to fork to escape. A Node or Rust CLI spends that window on
//! process startup, so in practice nothing escapes. The slice 3 acceptance
//! criterion is a CLI whose startup script spawns a grandchild; if that ever
//! fails, the fix is a hand-rolled `CreateProcessW`, and this comment is the
//! note explaining why it would be needed.

use std::io;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, RawHandle};

/// A job object holding one child and everything it spawns.
pub struct Job {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// The handle is owned solely by this struct and only used through it.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    /// Creates a job that kills its members when the handle closes.
    pub fn new() -> io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: a null name and null security attributes create an unnamed
        // job owned by this process. The returned handle is checked below.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: `handle` is a live job handle and `limits` is a correctly
        // sized, fully initialised structure of the class we name.
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .unwrap_or(u32::MAX),
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            // SAFETY: closing the handle we just created and are abandoning.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(error);
        }

        Ok(Self { handle })
    }

    /// Puts an already-running process, and its future descendants, in the job.
    pub fn assign(&self, child: &std::process::Child) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let raw: RawHandle = child.as_raw_handle();
        // SAFETY: `raw` is the live process handle owned by `child`, which
        // outlives this call, and `self.handle` is a live job handle.
        let ok = unsafe { AssignProcessToJobObject(self.handle, raw.cast()) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Kills every process in the job, now.
    ///
    /// Dropping the job does this too. This exists for an explicit stop, where
    /// waiting for the handle to close would be vague about when it happened.
    pub fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: `self.handle` is live for the lifetime of `self`. An exit
        // code of 1 marks these as killed rather than finished.
        unsafe { TerminateJobObject(self.handle, 1) };
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // Closing the last handle triggers KILL_ON_JOB_CLOSE, so this is what
        // guarantees no orphans even if kitty panics on the way out.
        // SAFETY: the handle is live and owned exclusively by this struct.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

// kitty targets Windows (ADR-0001). These exist so the crate still type-checks
// elsewhere, and they do not pretend to contain anything.
#[cfg(not(windows))]
impl Job {
    pub fn new() -> io::Result<Self> {
        Ok(Self {})
    }
    pub fn assign(&self, _child: &std::process::Child) -> io::Result<()> {
        Ok(())
    }
    pub fn terminate(&self) {}
}

#[cfg(test)]
mod tests {
    use super::Job;

    #[test]
    fn a_job_can_be_created_and_dropped() {
        let job = Job::new().expect("create job");
        drop(job);
    }

    #[test]
    fn terminating_a_job_kills_its_member() {
        let job = Job::new().expect("create job");
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn child");

        job.assign(&child).expect("assign to job");
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "child should still be running before we kill it"
        );

        job.terminate();

        assert!(
            died_within(&mut child, 10),
            "terminating the job did not kill its member"
        );
    }

    #[test]
    fn dropping_the_job_kills_its_member() {
        // This is the guarantee that matters: even an abrupt exit cannot leave
        // an agent CLI running.
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn child");

        {
            let job = Job::new().expect("create job");
            job.assign(&child).expect("assign to job");
        } // job dropped here

        assert!(
            died_within(&mut child, 10),
            "dropping the job did not kill its member"
        );
    }

    /// Waits for a child to die, always reaping it so no handle is left behind.
    fn died_within(child: &mut std::process::Child, seconds: u64) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
        while std::time::Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        false
    }
}
