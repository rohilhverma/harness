LLM Tokenization:

An LLM always converts a string of text into a sequence of substrings, and these substrings are then converted into actual integers. Generally they form like integer IDs that make it easier fo rthe LML to process them. 

What a sidecar would do is essentially tokenize and render an entire prompt, across the system, user, assistant, tools, etc. Idea is to reduce the token consumption, by maintaining the id and integers existing for all of these prompts that aren't changing, like the system, user, assistant prompts. 

When tehse tokens are processed, they formed embeddings, that go through various layers to form predictions and generations of LLM text. The thing that connects these embeddings together and allows an LLM to tie together information from across many different prompts is through attention. The mechanic follows a couple of different levels:

Current tokens that have been processed contain:
- Query: What information am I looking for
When tokens have been processed, they provide:
- Key: Here is the kind of information I contain
- Value: The the relevant information you get if you use me. 

The next step is to also store the Key and Value states that were calculated for every previously computed token, without any need to recreate Keys and Values. 

Prefil is where the model has to process a prompt that alreyad exists. SO talking like the system, tools, user rquests, previous turns, etc. Then decode is the task of generating these new tokens, like the process of generating and predicting new tokens. 

