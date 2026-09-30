Designing your own harness:

A very high level view, a harness is a while loop with judgement. 

Compose the initial context: system instructions, task, project knowledge. You loop, sending context to the model along with schema for the specific tools. The model now returns an answer, so check if the task is done, or if there were tool calls, see if requests to read a file, run a command, were done. You want to validate every request call that was carried out, execute allowed ones, and also append your final results to the context. 


1. Harness Assembles Context, System Instructions, Tool Schemas, Project Instruction Files, Task, and sends it. Model processes, and returns a tool call. The seperate permissions layer checks the permissions.

2. The model being to start reading files. It identifies the relevant information across the files, and proposes its plan as a message. 

3. It beings to start writing scripts to carry out an operation of choice. It is granted permission, builds a sandbox, and starts to evaluate and run the script. It fails, recieves it's error, and adjusts it's script accordingly. 

4. Most of the work has been done, the context is quite large now. You use a compaction to drop irrelevant file previews, and pin the task, plan, and error history, while writing a summary of plans, and returns an answer. 


---
Model Layer: Interface to your model. Always thinking about reliability, portability, cost hygiene. 

Tool Layer: How the agent acts. Every tool is defined as a typed schema, name, description, parameters, that a model will see, with an implemetnation on how the harness executes, and results returned for observation. 

Context Layer: What goes into the window, what order. System instruction defining role and rules, tool schemas, durable project context. Where harnesses source, the AGENTS.md convention, so you can shape the agent behavior. Then the task of working history of a session, so seperating good assembly from stuffing the model with so much content, they all ask for attention. Compaction, effectively trimming cheap and irrelevant outputs, repeated observations, summarizations of older exchanges, etc. 

Permission Layer: An agent needs awareness of what it can do. Classify tools into a risk category. Request calls are always rerouted to be authorized, and in the case of major errors, you need to contain the blast radiuds, run the execution in sandboxes, containeers, VMs to confire the file system. Log every kindo f tool, decision, approval at any moment so taht you can reconstruct them. 

Control Layer: The loop needs to know when to stop, giving it that knowledge is important. Create budgets on steps, max number of loop iterations, wall-clock time, tokens, cost, etc. Resumarize and then hand-off rather than cancel. 

Persistence Layer: What survives a session. It decides what acrries forward, and generally the answer is just files first. Plain files, MD notes, instructions, investigation journals, are used to organize simply/read thru the same tools the agent has, and outperofmrs basic memory architecture. It's easy for an agent writing it's own memory to mess it up, so you need a lot of rules, and idea of the conclusions that can be persisted. 

Orchestration Layer: Subagents are the lead agents that are delegating thier scoped work to child agents, earning their complexity in parallelism, and context isolation. Every child gets a rebuilt context and own permission scope. 

Evaluation Layer: You should create a huge set of real tasks with good outcomes, and run it on every modificiation you make to your system, and trace how it works end to end. 

Surface Layer: How the Humans and Systems are driving it. It generally is composed of 3 layers, where the headless surface is the one coming first, like a single-shot invocation that tasks a task, outputs work and a structured result. This makes it composable and schedulable. The Iterative Surface is the UI that allows for development and supervised work, like streaming the output so you can see how the agent thinks. Server surface is the strategic one, how you can exposing the with an API, so your editors, orchestrators, schedulers can all drive your agent. 

Bad Patterns:
- Too many tools that the model has to classify: fewer general tools, exposed in a readable structure
- Infinite Context: passing entire files, logs, complete history, all appended forever. It'll decay your performance, and increase your costs. 
- Permission Model: You didndly't safely allow the model with the guardrails to prevent your model from acting out of hand. 
- Unkillable Session: No budgets, stuck-loop detection, checkpoints, agent runs all weekend. 
- Eval-Free: You push any kind of prompt tweaks and model swaps, and each of improves a task and beraks other ones. 

A Staged Build: From Weekend to Production
Assemble the components into the path I recommend walking, because sequencing is half the wisdom.

Stage one, the honest weekend: the minimal loop, one model provider behind your abstraction, four general tools, read, list, search, shell-in-a-container, budgets on all four axes, and a permission matrix with two tiers. This system already does real work, and building it teaches more about agent behavior than a month of reading.

Stage two, the useful month: instruction-file loading, MCP client support to inherit the tool ecosystem, tool output truncation and offloading, the scratchpad-notes pattern, session transcripts, and the first eval set of ten real tasks. This is the stage where the harness starts winning against your expectations, and where cache-aware context ordering pays its first visible bills.

Stage three, the trustworthy quarter: progressive compaction with pinned task context, the event and hook system, approval-gated permission tiers with full audit logging, checkpoint and resume, failure-pattern detection in the control layer, and the eval set grown to fifty tasks with cost and success tracked per change. This is the production line: at this stage you can schedule the agent, hand it to teammates, and answer the incident-review question.

Stage four, chosen deliberately or skipped forever: subagents with isolated contexts and scopes, durable file-based memory with write governance, a server mode so other systems, including other agents, can drive your harness, and domain specialization, which is where your harness stops being a general clone and becomes the thing only your team could have built, the reason to have walked the path at all.


---
