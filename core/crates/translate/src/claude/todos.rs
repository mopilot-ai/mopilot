//! Claude Code's own task lists as one plan (`turn/plan/updated`): TodoWrite's whole list, and the tasks TaskCreate and
//! TaskUpdate keep by id, so either reaches the chat's pinned task box.

use crate::claude::common::{cat, map_key, result_text};
use crate::claude::patterns as re;
use crate::ordered::Ordered;
use crate::reads::{at, is, string, text_from};
use crate::Thrown;
use jsvalue::js::{given, to_text, truthy};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};
use std::collections::HashMap;

/// A plan's status for what the tool said: `STATUS[status]`, in which JS read a list's or a number's string too.
fn status_of(status: Option<&Value>) -> Result<Option<&'static str>, Thrown> {
    let Some(status) = status else { return Ok(None) };
    Ok(match to_text(status)?.as_bytes() {
        b"pending" => Some("pending"),
        b"in_progress" => Some("inProgress"),
        b"completed" => Some("completed"),
        _ => None,
    })
}

/// `typeof v === 'string' && v.trim() ? v.trim() : null`.
fn text(value: Option<&Value>) -> Option<Text> {
    let trimmed = trim(string(value)?.as_bytes());
    (!trimmed.is_empty()).then(|| text_from(trimmed))
}

/// `text(v == null ? null : String(v))`.
fn id_text(value: Option<&Value>) -> Result<Option<Text>, Thrown> {
    let Some(value) = given(value) else { return Ok(None) };
    Ok(text(Some(&Value::String(to_text(value)?))))
}

fn step(step: Text, status: &str) -> Value {
    Value::Object(Object::of([("step", Value::String(step)), ("status", Value::text(status))]))
}

/// One translator's task list: what each call or result makes of it.
#[derive(Default)]
pub struct Todos {
    /// task id -> its step and status, in the order the tasks were made
    tasks: Ordered<(Text, &'static str)>,
    /// TaskCreate calls waiting for the result that names their task: tool_use id -> subject
    pub creates: HashMap<Text, Option<Text>>,
}

impl Todos {
    fn steps(&self) -> Value {
        Value::Array(self.tasks.values().map(|(name, status)| step(name.clone(), status)).collect())
    }

    /// The plan after a task tool's call, or `None` when it shows nothing yet. A TaskCreate's waits for the task's id.
    pub fn apply(&mut self, block: &Object) -> Result<Option<Value>, Thrown> {
        let empty = Value::Object(Object::default());
        let input = given(block.get("input")).unwrap_or(&empty);
        if is(block.get("name"), "TodoWrite") {
            let todos = input.field("todos").and_then(Value::as_array).unwrap_or_default();
            let mut steps = Vec::with_capacity(todos.len());
            for todo in todos {
                let name = text(todo.field("content")).or_else(|| text(todo.field("activeForm"))).unwrap_or_default();
                steps.push(step(name, status_of(todo.field("status"))?.unwrap_or("pending")));
            }
            return Ok(Some(Value::Array(steps)));
        }
        if is(block.get("name"), "TaskCreate") {
            self.creates.insert(map_key(block.get("id")), text(input.field("subject")));
            return Ok(None);
        }
        let Some(id) = id_text(input.field("taskId"))? else { return Ok(None) };
        if is(input.field("status"), "deleted") {
            self.tasks.delete(&id);
        } else {
            // a task made before this translator's first message (an older page of history) gets its id for a name
            let (name, status) = self.tasks.get(&id).cloned().unwrap_or_else(|| (cat!("Task ", &id), "pending"));
            let next = (text(input.field("subject")).unwrap_or(name), status_of(input.field("status"))?.unwrap_or(status));
            self.tasks.set(id, next);
        }
        Ok(Some(self.steps()))
    }

    /// The plan after a tool result, or `None` when it is not a TaskCreate's or made no task: the new task's id is in the
    /// structured result, or in its text ("Task #3 created successfully: ...").
    pub fn result(&mut self, block: &Object, structured: Option<&Value>) -> Result<Option<Value>, Thrown> {
        let Some(subject) = self.creates.remove(&map_key(block.get("tool_use_id"))) else { return Ok(None) };
        if block.get("is_error").is_some_and(truthy) {
            return Ok(None);
        }
        let task = at(structured, "task");
        let id = match id_text(at(task, "id"))? {
            Some(id) => Some(id),
            None => re::task_number(result_text(block.get("content")).as_bytes()).map(text_from),
        };
        let Some(id) = id else { return Ok(None) };
        let name = subject.or_else(|| text(at(task, "subject"))).unwrap_or_else(|| cat!("Task ", &id));
        self.tasks.set(id, (name, "pending"));
        Ok(Some(self.steps()))
    }
}
