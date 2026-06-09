import { useState, useRef, useEffect } from "react";

const STEPS = [
  { id:"setup",    label:"Brief & Interviewees" },
  { id:"conduct",  label:"Interviews" },
  { id:"live",     label:"Live interview" },
  { id:"insights", label:"Insights" },
];

const AVCOLORS = ["#E6F1FB","#E1F5EE","#FAEEDA","#FAECE7","#EEEDFE","#EAF3DE"];
const AVTXT    = ["#0C447C","#085041","#633806","#712B13","#3C3489","#27500A"];
const FMETA = {
  csv:{label:"CSV",color:"#16A34A",bg:"#F0FDF4"},
  xlsx:{label:"XLS",color:"#16A34A",bg:"#F0FDF4"},
  xls:{label:"XLS",color:"#16A34A",bg:"#F0FDF4"},
  pdf:{label:"PDF",color:"#DC2626",bg:"#FEF2F2"},
  docx:{label:"DOC",color:"#2563EB",bg:"#EFF6FF"},
  doc:{label:"DOC",color:"#2563EB",bg:"#EFF6FF"},
  pptx:{label:"PPT",color:"#EA580C",bg:"#FFF7ED"},
  ppt:{label:"PPT",color:"#EA580C",bg:"#FFF7ED"},
  txt:{label:"TXT",color:"#6B7280",bg:"#F9FAFB"},
};
function fext(n){ return (n.split(".").pop()||"").toLowerCase(); }
function fmeta(n){ return FMETA[fext(n)] || {label:"FILE",color:"#6B7280",bg:"#F9FAFB"}; }
function fbytes(b){ if(b<1024) return b+"B"; if(b<1048576) return Math.round(b/1024)+"KB"; return (b/1048576).toFixed(1)+"MB"; }

async function ai(msgs, sys, model) {
  var m = model || "claude-sonnet-4-20250514";
  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({model:m, max_tokens:1000, system:sys, messages:msgs}),
  });
  var d = await res.json();
  return (d.content || []).map(function(b){ return b.text||""; }).join("");
}
function haiku(msgs, sys){ return ai(msgs, sys, "claude-sonnet-4-20250514"); }

// Campaign chat with web search — allows Claude to fetch URLs shared by the user
async function aiWithSearch(msgs, sys) {
  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      model:"claude-sonnet-4-20250514",
      max_tokens:2000,
      system:sys,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      messages:msgs
    }),
  });
  var d = await res.json();
  // Collect all text blocks — may include tool use results interleaved
  var parts = (d.content || []).map(function(b){ return b.text||""; });
  return parts.join("").trim();
}

async function readFile(file) {
  try { return await file.text(); } catch(e) { return ""; }
}

async function parseEmpText(text) {
  if (!text || text.length < 20) return [];
  try {
    var raw = await ai(
      [{role:"user", content:"Parse this into a JSON array of employees. Each item: name, role, dept, seniority (C-Suite/VP/Director/Senior/Mid/Junior), location, knowledge (array of 3-5 strings). Return ONLY the JSON array, no markdown:\n\n" + text.slice(0,4000)}],
      "You parse employee data into JSON arrays. Return only valid JSON, no markdown, no explanation."
    );
    var clean = raw.replace(/```json/g,"").replace(/```/g,"").trim();
    var arr = JSON.parse(clean);
    return arr.map(function(e,i) {
      var nm = e.name || "Unknown";
      var parts = nm.split(" ");
      var inits = parts.map(function(w){ return w[0]||""; }).join("").slice(0,2).toUpperCase();
      return {
        id: 2000 + i,
        name: nm,
        initials: inits,
        role: e.role || e.title || "Unknown Role",
        dept: e.dept || e.department || "Unknown",
        seniority: e.seniority || "Mid",
        location: e.location || "Unknown",
        knowledge: Array.isArray(e.knowledge) ? e.knowledge : [],
      };
    });
  } catch(e) { return []; }
}

function Av({initials, size, idx}) {
  var s = size || 36;
  var ci = (idx || 0) % AVCOLORS.length;
  return (
    <div style={{width:s,height:s,borderRadius:"50%",background:AVCOLORS[ci],
      display:"flex",alignItems:"center",justifyContent:"center",
      fontSize:Math.round(s*0.33),fontWeight:500,color:AVTXT[ci],flexShrink:0}}>
      {initials}
    </div>
  );
}

function Conf({score}) {
  var bg = score >= 85 ? "#E1F5EE" : score >= 70 ? "#FAEEDA" : "#FAECE7";
  var col = score >= 85 ? "#0F6E56" : score >= 70 ? "#633806" : "#712B13";
  return <span style={{background:bg,color:col,fontSize:11,fontWeight:500,padding:"2px 8px",borderRadius:20}}>{score}%</span>;
}

function Dots() {
  return (
    <span style={{display:"inline-flex",gap:3,alignItems:"center"}}>
      {[0,1,2].map(function(i) {
        return <span key={i} style={{width:5,height:5,borderRadius:"50%",background:"#9CA3AF",
          opacity:0.5,animation:"gd 1.2s ease-in-out "+i*0.2+"s infinite"}}></span>;
      })}
      <style>{"@keyframes gd{0%,80%,100%{transform:scale(0.6);opacity:0.3}40%{transform:scale(1);opacity:1}}"}</style>
    </span>
  );
}

function Logo({size}) {
  var s = size || 28;
  return (
    <div style={{width:s,height:s,background:"#1a1a2e",borderRadius:Math.round(s*0.25),
      display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
      <span style={{color:"#fff",fontSize:Math.round(s*0.46),fontWeight:700}}>G</span>
    </div>
  );
}

function FileChip({file, onRemove}) {
  var m = fmeta(file.name);
  var stColor = file.status==="done" ? "#16A34A" : file.status==="error" ? "#DC2626" : "#6B7280";
  return (
    <div style={{display:"inline-flex",alignItems:"center",gap:5,background:"#fff",
      border:"1px solid #E5E7EB",borderRadius:7,padding:"4px 6px 4px 7px",flexShrink:0,
      boxShadow:"0 1px 2px rgba(0,0,0,0.04)",maxWidth:190}}>
      <div style={{width:20,height:20,borderRadius:4,background:m.bg,display:"flex",
        alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700,
        color:m.color,flexShrink:0,letterSpacing:0.3}}>
        {m.label}
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:11,fontWeight:500,color:"#111827",overflow:"hidden",
          textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:100}}>{file.name}</div>
        <div style={{fontSize:10,color:stColor}}>
          {file.status==="parsing" && "Parsing..."}
          {file.status==="done" && ("Done " + fbytes(file.size))}
          {file.status==="error" && "Error"}
          {file.status==="ready" && fbytes(file.size)}
        </div>
      </div>
      <button onClick={function(){ onRemove(file.id); }}
        style={{background:"none",border:"none",cursor:"pointer",color:"#9CA3AF",
          padding:"0 2px",fontSize:14,lineHeight:1,flexShrink:0}}>
        x
      </button>
    </div>
  );
}

function ChatBar({value, onChange, onKeyDown, onSend, loading, placeholder, files, onAddFiles, onRemoveFile}) {
  var fileRef = useRef(null);
  var [drag, setDrag] = useState(false);

  function handleFiles(list) {
    var ok = Array.from(list).filter(function(f) {
      return ["csv","xlsx","xls","pdf","docx","doc","pptx","ppt","txt"].indexOf(fext(f.name)) >= 0;
    });
    if (ok.length) onAddFiles(ok);
  }

  var canSend = !loading && (value.trim() || files.some(function(f){ return f.status==="done"; }));

  return (
    <div
      onDragOver={function(e){ e.preventDefault(); setDrag(true); }}
      onDragLeave={function(){ setDrag(false); }}
      onDrop={function(e){ e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); }}
      style={{border:"1.5px solid "+(drag?"#1a1a2e":"#D1D5DB"),borderRadius:12,
        background:"#fff",transition:"border-color 0.15s",position:"relative"}}>
      {files.length > 0 && (
        <div style={{padding:"7px 10px 0",display:"flex",flexWrap:"wrap",gap:5,
          borderBottom:"1px solid #F3F4F6"}}>
          {files.map(function(f) {
            return <FileChip key={f.id} file={f} onRemove={onRemoveFile} />;
          })}
        </div>
      )}
      <div style={{display:"flex",alignItems:"center"}}>
        <button
          title="Attach files"
          onClick={function(){ if(fileRef.current) fileRef.current.click(); }}
          style={{background:"none",border:"none",cursor:"pointer",padding:"9px 8px 9px 12px",
            color:"#9CA3AF",flexShrink:0,lineHeight:1}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>
        <input ref={fileRef} type="file" multiple
          accept=".csv,.xlsx,.xls,.pdf,.docx,.doc,.pptx,.ppt,.txt"
          onChange={function(e){ handleFiles(e.target.files); e.target.value=""; }}
          style={{display:"none"}} />
        <input
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder || "Ask a question..."}
          disabled={loading}
          style={{flex:1,border:"none",outline:"none",padding:"10px 6px",
            fontSize:13.5,color:"#111827",background:"transparent"}} />
        <button
          onClick={onSend}
          disabled={!canSend}
          style={{margin:"6px 8px",background:"#1a1a2e",color:"#fff",border:"none",
            borderRadius:8,padding:"7px 16px",fontSize:13,fontWeight:500,cursor:"pointer",
            opacity:canSend?1:0.35,flexShrink:0,minWidth:52,
            display:"flex",alignItems:"center",justifyContent:"center"}}>
          {loading ? <Dots /> : "Send"}
        </button>
      </div>
    </div>
  );
}

function useFiles(onEmps, onCtx) {
  var [files, setFiles] = useState([]);

  async function addFiles(rawList) {
    var entries = rawList.map(function(f) {
      return {id: f.name+"-"+Date.now()+"-"+Math.random(), name:f.name, size:f.size, status:"parsing", content:"", raw:f};
    });
    setFiles(function(p){ return p.concat(entries); });
    for (var i=0; i<entries.length; i++) {
      var entry = entries[i];
      try {
        var text = await readFile(entry.raw);
        var emps = await parseEmpText(text);
        setFiles(function(p){ return p.map(function(f){ return f.id===entry.id ? Object.assign({},f,{status:"done",content:text}) : f; }); });
        if (emps.length && onEmps) onEmps(emps);
        if (onCtx) onCtx({name:entry.name, content:text, employees:emps});
      } catch(e) {
        setFiles(function(p){ return p.map(function(f){ return f.id===entry.id ? Object.assign({},f,{status:"error"}) : f; }); });
      }
    }
  }

  function remove(id) { setFiles(function(p){ return p.filter(function(f){ return f.id!==id; }); }); }
  function clear() { setFiles([]); }
  return {files, addFiles, remove, clear};
}

function AddPersonModal({candidates, onAdd, onClose}) {
  // candidates = recs not yet in sel
  var [picked, setPicked] = useState({});

  function toggle(emp) {
    setPicked(function(p) {
      var next = Object.assign({}, p);
      if (next[emp.id]) { delete next[emp.id]; } else { next[emp.id] = emp; }
      return next;
    });
  }

  var selected = Object.values(picked);
  var canAdd = selected.length > 0;

  function submit() {
    selected.forEach(function(emp) { onAdd(emp); });
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:300,
      display:"flex",alignItems:"center",justifyContent:"center"}}
      onClick={function(e){ if(e.target===e.currentTarget) onClose(); }}>
      <div style={{background:"#fff",borderRadius:14,width:440,maxHeight:"70vh",
        display:"flex",flexDirection:"column",
        border:"1px solid #E5E7EB",boxShadow:"0 8px 32px rgba(0,0,0,0.12)"}}>

        <div style={{padding:"16px 20px",borderBottom:"1px solid #E5E7EB",
          display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <p style={{fontSize:15,fontWeight:600,color:"#111827",margin:"0 0 2px"}}>Add to interviewees</p>
            <p style={{fontSize:12,color:"#6B7280",margin:0}}>Select from this campaign's recommended list</p>
          </div>
          <button onClick={onClose}
            style={{background:"none",border:"none",fontSize:20,cursor:"pointer",
              color:"#9CA3AF",lineHeight:1,padding:"0 2px"}}>
            x
          </button>
        </div>

        <div style={{overflowY:"auto",flex:1,padding:"8px 12px"}}>
          {candidates.length === 0 && (
            <div style={{padding:"24px 0",textAlign:"center"}}>
              <p style={{fontSize:13,color:"#6B7280",margin:"0 0 4px"}}>Everyone is already selected.</p>
              <p style={{fontSize:12,color:"#9CA3AF",margin:0}}>Ask Gaura to recommend more people in the chat.</p>
            </div>
          )}
          {candidates.map(function(emp, i) {
            var isP = !!picked[emp.id];
            return (
              <div key={emp.id} onClick={function(){ toggle(emp); }}
                style={{display:"flex",alignItems:"center",gap:10,padding:"10px 10px",
                  borderRadius:8,cursor:"pointer",marginBottom:4,
                  background:isP?"#EFF6FF":"transparent",
                  border:"1px solid "+(isP?"#BFDBFE":"transparent")}}>
                <Av initials={emp.initials||(emp.name||"?").slice(0,2)} size={32} idx={i} />
                <div style={{flex:1,minWidth:0}}>
                  <p style={{fontSize:13,fontWeight:500,color:"#111827",margin:0}}>{emp.name}</p>
                  <p style={{fontSize:12,color:"#6B7280",margin:0}}>{emp.role} - {emp.location}</p>
                  {emp.relevance && (
                    <p style={{fontSize:11,color:"#9CA3AF",margin:"2px 0 0",
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {emp.relevance}
                    </p>
                  )}
                </div>
                <div style={{width:18,height:18,borderRadius:5,flexShrink:0,
                  background:isP?"#2563EB":"transparent",
                  border:"1.5px solid "+(isP?"#2563EB":"#D1D5DB"),
                  display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {isP && (
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                      <polyline points="2,6 5,9 10,3" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{padding:"12px 16px",borderTop:"1px solid #F3F4F6",
          display:"flex",gap:8,justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:12,color:"#6B7280"}}>
            {canAdd ? selected.length + " selected" : "Select people above"}
          </span>
          <div style={{display:"flex",gap:8}}>
            <button onClick={onClose}
              style={{padding:"8px 14px",borderRadius:8,border:"1px solid #E5E7EB",
                background:"transparent",fontSize:13,cursor:"pointer",color:"#6B7280"}}>
              Cancel
            </button>
            <button onClick={submit} disabled={!canAdd}
              style={{padding:"8px 18px",borderRadius:8,border:"none",background:"#1a1a2e",
                color:"#fff",fontSize:13,fontWeight:500,cursor:"pointer",
                opacity:canAdd?1:0.4}}>
              Add {canAdd ? selected.length + " person" + (selected.length>1?"s":"") : ""}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── VOICE INTERVIEW COMPONENT ─────────────────────────────────────────────────
// Used both in the campaign workspace (Live Interview tab) and the standalone
// interviewee page (shareable link). Handles both text and voice modes.

function VoiceInterview(props) {
  var config = props.config;
  var person = props.person;
  var question = props.question;
  var guide = props.guide || null;
  var onDone = props.onDone;
  var isVoice = config.mode === "Voice";

  // Length -> question target mapping
  var LENGTH_MAP = {short:{target:5,topics:2,label:"Short"},standard:{target:10,topics:3,label:"Standard"},thorough:{target:15,topics:4,label:"Thorough"}};
  var lengthCfg = LENGTH_MAP[config.length] || LENGTH_MAP.standard;
  var questionTarget = guide && guide.questions ? guide.questions.length : lengthCfg.target;

  var [msgs, setMsgs] = useState([]);
  var [inp, setInp] = useState("");
  var [loading, setLoading] = useState(false);
  var [started, setStarted] = useState(false);
  var [ended, setEnded] = useState(false);
  var [listening, setListening] = useState(false);
  var [speaking, setSpeaking] = useState(false);
  var [voiceError, setVoiceError] = useState("");
  var [transcript, setTranscript] = useState("");
  var chatRef = useRef(null);
  var recognRef = useRef(null);
  var synthRef = useRef(window.speechSynthesis || null);

  // Count AI turns (questions asked)
  var aiTurns = msgs.filter(function(m){ return m.role==="ai"; }).length;

  useEffect(function() {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [msgs, loading]);

  // Cancel speech and mic on unmount
  useEffect(function() {
    return function() {
      if (synthRef.current) synthRef.current.cancel();
      if (recognRef.current) { try { recognRef.current.stop(); } catch(e2){} }
    };
  }, []);

  // Build a numbered checklist of guide questions with completion status
  var guideQuestions = guide && guide.questions ? guide.questions : [];
  var totalQ = guideQuestions.length || questionTarget;
  // Estimate which guide question we're on based on AI turns
  // Each guide question gets ~1-2 follow-ups before moving on
  var estQIdx = Math.min(Math.floor(aiTurns / 2), totalQ - 1);
  var coveredCount = Math.min(aiTurns, totalQ);
  var remainingQ = guideQuestions.slice(estQIdx);
  var questionsLeft = totalQ - coveredCount;
  var nearingEnd = questionsLeft <= 1;

  // Format the full guide into the system prompt
  var guideBlock = "";
  if (guideQuestions.length > 0) {
    guideBlock = "\n\nINTERVIEW GUIDE — YOU MUST FOLLOW THIS EXACTLY:\n";
    if (guide.objective) guideBlock += "Objective: " + guide.objective + "\n";
    guideBlock += "\nQUESTIONS TO COVER (in order — do not skip any):\n";
    guideQuestions.forEach(function(q, i) {
      var status = i < estQIdx ? "[DONE]" : i === estQIdx ? "[CURRENT]" : "[PENDING]";
      guideBlock += (i+1) + ". " + status + " " + q + "\n";
    });
    if (guide.followups && guide.followups.length) {
      guideBlock += "\nKEY FOLLOW-UP AREAS (use these to probe deeper on any question):\n";
      guide.followups.forEach(function(f) { guideBlock += "- " + f + "\n"; });
    }
    if (remainingQ.length > 0) {
      guideBlock += "\nYOU STILL NEED TO COVER " + remainingQ.length + " QUESTION(S):\n";
      remainingQ.forEach(function(q, i) { guideBlock += "- " + q + "\n"; });
    }
  }

  var sys = "You are Gaura, an AI interviewer. Your PRIMARY job is to work through every question in the interview guide without skipping any.\n" +
    "Interviewee: " + person.name + ", " + person.role + ".\n" +
    "Business question: " + question + "\n" +
    "Tone: " + config.tone + ". Depth: " + config.depth + ".\n" +
    guideBlock + "\n\n" +
    "STRICT RULES:\n" +
    "1. NEVER skip a guide question. Work through them in order.\n" +
    "2. For each guide question: ask it, then probe with 1-2 follow-up WHY questions (5 Whys method), then move to the next guide question.\n" +
    "3. After each topic is probed, briefly propose ONE hypothesis solution and ask for a reaction — e.g. 'One approach we are considering is X. What is your view on that?' This tests whether the solution makes sense from their perspective.\n" +
    "4. If the interviewee gives a short answer, push deeper before moving on: 'Can you give me a specific example?' or 'What caused that to happen?'\n" +
    "5. Keep pacing in mind: you have " + totalQ + " questions total and have covered approximately " + coveredCount + " so far.\n" +
    (nearingEnd ? "6. IMPORTANT: You are on the last question. After their answer, summarise the 3-4 key themes you heard and thank them warmly.\n" : "") +
    "\nVOICE FORMAT: 1-3 sentences per turn. Natural conversational speech only — no bullet points, no numbered lists, no headers.";


  function speak(text, afterFn) {
    if (!synthRef.current) { if (afterFn) afterFn(); return; }
    synthRef.current.cancel();
    var utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.95;
    utter.pitch = 1.0;
    utter.volume = 1.0;
    // Pick a good voice if available
    var voices = synthRef.current.getVoices();
    var preferred = voices.filter(function(v) {
      return v.lang.startsWith("en") && !v.name.toLowerCase().includes("zira");
    });
    if (preferred.length) utter.voice = preferred[0];
    utter.onstart = function() { setSpeaking(true); };
    utter.onend = function() { setSpeaking(false); if (afterFn) afterFn(); };
    utter.onerror = function() { setSpeaking(false); if (afterFn) afterFn(); };
    setSpeaking(true);
    synthRef.current.speak(utter);
  }

  var finalTranscriptRef = useRef("");
  var shouldListenRef = useRef(false);

  function startListening() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setVoiceError("Speech recognition requires Chrome."); return; }
    var recog = new SR();
    recog.continuous = true;       // stay open — never auto-stop
    recog.interimResults = true;   // show live transcript while speaking
    recog.lang = "en-US";
    recog.maxAlternatives = 1;
    recognRef.current = recog;

    recog.onstart = function() {
      setListening(true);
      setTranscript("");
      finalTranscriptRef.current = "";
    };

    recog.onresult = function(e) {
      var interim = "";
      var finalT = "";
      for (var i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalT += e.results[i][0].transcript + " ";
        } else {
          interim += e.results[i][0].transcript;
        }
      }
      finalTranscriptRef.current = finalT;
      setTranscript((finalT + interim).trim());
    };

    recog.onend = function() {
      // Auto-restart if we should still be listening (browser timeout)
      if (shouldListenRef.current && !loading) {
        try { recog.start(); } catch(e2) {}
      } else {
        setListening(false);
      }
    };

    recog.onerror = function(e) {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setVoiceError("Mic error: " + e.error + " — tap mic to retry");
      setListening(false);
      shouldListenRef.current = false;
    };

    try { recog.start(); } catch(e) { setVoiceError("Could not start microphone."); }
  }

  function stopListening() {
    shouldListenRef.current = false;
    setListening(false);
    if (recognRef.current) {
      try { recognRef.current.stop(); recognRef.current.abort(); } catch(e2){}
      recognRef.current = null;
    }
    setTranscript("");
    finalTranscriptRef.current = "";
  }

  async function sendVoice(txt) {
    if (!txt || loading) return;
    stopListening();
    var nm = msgs.concat([{role:"user", text:txt}]);
    setMsgs(nm);
    setLoading(true);
    var api = nm.map(function(m) {
      return {role: m.role==="ai"?"assistant":"user", content: m.text};
    });
    try {
      var r = await haiku(api, sys);
      var newMsgs = nm.concat([{role:"ai", text:r}]);
      setMsgs(newMsgs);
      setLoading(false);
      if (isVoice) speak(r);
    } catch(e) {
      setMsgs(function(p){ return p.concat([{role:"ai",text:"Could you expand on that?"}]); });
      setLoading(false);
    }
  }

  async function sendText() {
    if (!inp.trim() || loading) return;
    var txt = inp.trim();
    setInp("");
    await sendVoice(txt);
  }

  async function startInterview() {
    setStarted(true);
    setLoading(true);
    var greeting = "Begin. Greet " + person.name + " warmly and ask your first question. Keep it concise for voice.";
    try {
      var r = await haiku([{role:"user",content:greeting}], sys);
      setMsgs([{role:"ai",text:r}]);
      setLoading(false);
      if (isVoice) speak(r);
    } catch(e) {
      setMsgs([{role:"ai",text:"Hello, thank you for joining. Let's get started — could you tell me about the main challenges you're currently facing?"}]);
      setLoading(false);
    }
  }


  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%",minHeight:320}}>

      {/* Header */}
      <div style={{padding:"12px 16px",borderBottom:"1px solid #E5E7EB",background:"#fff",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <Av initials={person.initials||(person.name||"?").slice(0,2)} size={34} idx={0} />
          <div style={{flex:1}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
              <span style={{fontSize:13,fontWeight:600,color:"#111827"}}>{person.name}</span>
              <span style={{fontSize:11,
                background:speaking?"#EFF6FF":started&&!ended?"#F0FDF4":"#F9FAFB",
                color:speaking?"#2563EB":started&&!ended?"#0F6E56":"#6B7280",
                padding:"2px 8px",borderRadius:10,fontWeight:500}}>
                {!started?"Ready":ended?"Complete":speaking?"Speaking...":listening?"Listening...":"Live"}
              </span>
              {isVoice && <span style={{fontSize:11,color:"#6B7280",background:"#F3F4F6",padding:"2px 7px",borderRadius:8}}>Voice</span>}
            </div>
            <p style={{fontSize:12,color:"#6B7280",margin:0}}>{person.role}</p>
          </div>
          {started && (
            <span style={{fontSize:11,color:"#9CA3AF",background:"#F9FAFB",padding:"2px 9px",borderRadius:8}}>
              Q{Math.min(estQIdx+1, totalQ)} of {totalQ}
            </span>
          )}
        </div>

        {voiceError && <p style={{fontSize:11,color:"#DC2626",margin:"6px 0 0"}}>{voiceError}</p>}
      </div>

      {/* Transcript */}
      <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:"16px 20px"}}>
        {!started && (
          <div style={{textAlign:"center",padding:"32px 16px"}}>
            <Logo size={44} />
            <p style={{fontSize:15,fontWeight:600,color:"#111827",margin:"14px 0 6px"}}>
              Ready to begin
            </p>
            <p style={{fontSize:13,color:"#6B7280",margin:"0 0 8px",lineHeight:1.6}}>
              {lengthCfg.label} {config.tone.toLowerCase()} interview — {totalQ} questions
            </p>
            <p style={{fontSize:12,color:"#9CA3AF",margin:"0 0 24px",lineHeight:1.5}}>
              Tap the mic button to speak your answers, or type them. Works in Chrome.
            </p>
            <button onClick={startInterview}
              style={{background:"#1a1a2e",color:"#fff",border:"none",borderRadius:10,
                padding:"12px 28px",fontSize:14,fontWeight:600,cursor:"pointer"}}>
              Start interview
            </button>
          </div>
        )}

        {msgs.map(function(m,i) {
          return (
            <div key={i} style={{display:"flex",gap:10,marginBottom:16,alignItems:"flex-start"}}>
              {m.role==="ai"
                ? <div style={{width:28,height:28,borderRadius:7,background:"#1a1a2e",
                    display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <span style={{color:"#fff",fontSize:9,fontWeight:700}}>G</span>
                  </div>
                : <Av initials={person.initials||(person.name||"?").slice(0,2)} size={28} idx={0} />
              }
              <div style={{flex:1}}>
                <p style={{fontSize:11,fontWeight:600,color:"#9CA3AF",margin:"0 0 4px"}}>
                  {m.role==="ai" ? "Gaura" : person.name}
                </p>
                <div style={{background:m.role==="ai"?"#F9FAFB":"#fff",
                  border:"1px solid "+(m.role==="ai"?"#F3F4F6":"#E5E7EB"),
                  borderRadius:10,padding:"9px 13px"}}>
                  <p style={{fontSize:13,color:"#111827",margin:0,lineHeight:1.75}}>{m.text}</p>
                </div>
              </div>
            </div>
          );
        })}

        {/* Live mic transcript preview */}
        {listening && transcript && (
          <div style={{display:"flex",gap:10,marginBottom:16,alignItems:"flex-start",opacity:0.6}}>
            <Av initials={person.initials||(person.name||"?").slice(0,2)} size={28} idx={0} />
            <div style={{background:"#EFF6FF",border:"1px dashed #BFDBFE",borderRadius:10,padding:"9px 13px",flex:1}}>
              <p style={{fontSize:13,color:"#374151",margin:0,fontStyle:"italic"}}>{transcript}</p>
            </div>
          </div>
        )}

        {loading && started && (
          <div style={{display:"flex",gap:10,marginBottom:16}}>
            <div style={{width:28,height:28,borderRadius:7,background:"#1a1a2e",
              display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <span style={{color:"#fff",fontSize:9,fontWeight:700}}>G</span>
            </div>
            <div style={{background:"#F9FAFB",border:"1px solid #F3F4F6",borderRadius:10,padding:"10px 13px"}}>
              <Dots />
            </div>
          </div>
        )}

        {ended && !loading && (
          <div style={{background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:10,
            padding:"16px",textAlign:"center",marginTop:8}}>
            <p style={{fontSize:13,fontWeight:600,color:"#0F6E56",margin:"0 0 4px"}}>Interview complete</p>
            <p style={{fontSize:12,color:"#6B7280",margin:"0 0 12px"}}>Thank you {person.name}. Your responses have been recorded.</p>
            <button onClick={function(){ onDone(msgs); }}
              style={{background:"#0F6E56",color:"#fff",border:"none",borderRadius:8,
                padding:"10px 20px",fontSize:13,fontWeight:500,cursor:"pointer"}}>
              Generate insight report
            </button>
          </div>
        )}
      </div>

      {/* Input bar — always shows mic + text input together */}
      {started && !ended && (
        <div style={{padding:"12px 16px",borderTop:"1px solid #E5E7EB",background:"#fff",flexShrink:0}}>
          {/* Live transcript preview while mic is active */}
          {listening && transcript && (
            <div style={{marginBottom:8,padding:"7px 12px",background:"#EFF6FF",
              border:"1px dashed #BFDBFE",borderRadius:8,fontSize:12,color:"#374151",fontStyle:"italic"}}>
              {transcript}
            </div>
          )}
          <div style={{display:"flex",gap:8,alignItems:"center"}}>

            {/* Mic button — always visible */}
            <button
              title={listening ? "Tap to send answer" : "Tap to speak"}
              onClick={function(){
                if (speaking || loading) return;
                if (listening) {
                  var ans = finalTranscriptRef.current.trim() || transcript.trim();
                  if (ans) { setInp(""); sendVoice(ans); }
                  else { stopListening(); }
                } else {
                  shouldListenRef.current = true;
                  startListening();
                }
              }}
              disabled={speaking || loading}
              style={{
                width:42, height:42, borderRadius:"50%", border:"none", cursor:"pointer",
                background:listening?"#DC2626":speaking||loading?"#E5E7EB":"#1a1a2e",
                display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
                boxShadow:listening?"0 0 0 5px rgba(220,38,38,0.18)":"0 1px 4px rgba(0,0,0,0.15)",
                transition:"all 0.2s", opacity:speaking||loading?0.5:1
              }}>
              {listening ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                  <rect x="6" y="6" width="12" height="12" rx="2"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
                </svg>
              )}
            </button>

            {/* Text input */}
            <input
              value={listening ? transcript : inp}
              onChange={function(e){ if(!listening) setInp(e.target.value); }}
              onKeyDown={function(e){
                if (e.key==="Enter" && !loading) {
                  if (listening) {
                    var ans = finalTranscriptRef.current.trim() || transcript.trim();
                    if (ans) { sendVoice(ans); }
                  } else {
                    sendText();
                  }
                }
              }}
              placeholder={
                speaking ? "Gaura is speaking..." :
                listening ? "Listening — tap mic or Enter to send" :
                "Type your answer or tap the mic..."
              }
              disabled={loading || speaking}
              readOnly={listening}
              style={{
                flex:1, border:"1.5px solid "+( listening?"#BFDBFE":"#D1D5DB"),
                borderRadius:9, padding:"9px 13px",
                fontSize:13, background:listening?"#EFF6FF":"#fff",
                color:"#111827", outline:"none",
                fontStyle:listening?"italic":"normal",
                cursor:listening?"default":"text"
              }}
            />
            {/* Send button */}
            <button
              onClick={function(){
                if (listening) {
                  var ans = finalTranscriptRef.current.trim() || transcript.trim();
                  if (ans) sendVoice(ans);
                } else {
                  sendText();
                }
              }}
              disabled={loading || speaking || (listening ? !transcript.trim() : !inp.trim())}
              style={{background:"#1a1a2e",color:"#fff",border:"none",borderRadius:9,
                padding:"0 18px",height:42,fontSize:13,fontWeight:500,cursor:"pointer",flexShrink:0,
                opacity:loading||speaking||(listening?!transcript.trim():!inp.trim())?0.35:1}}>
              Send
            </button>

          </div>
        </div>
      )}
    </div>
  );
}


function Explore({onBack}) {
  var [emps, setEmps] = useState([]);
  var [fileCtxs, setFileCtxs] = useState([]);
  var [msgs, setMsgs] = useState([]);
  var [input, setInput] = useState("");
  var [loading, setLoading] = useState(false);
  var [recs, setRecs] = useState(null);
  var [sel, setSel] = useState([]);
  var [showAdd, setShowAdd] = useState(false);
  var chatRef = useRef(null);
  var fu = useFiles(
    function(newEmps){ setEmps(function(p){ return p.concat(newEmps); }); },
    function(ctx){ setFileCtxs(function(p){ return p.concat([ctx]); }); }
  );

  useEffect(function(){
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [msgs, loading]);

  async function send() {
    var q = input.trim();
    var doneFiles = fu.files.filter(function(f){ return f.status==="done"; });
    if (!q && !doneFiles.length) return;
    setInput(""); fu.clear();

    var userText = q || ("Uploaded: " + doneFiles.map(function(f){ return f.name; }).join(", "));
    var newMsgs = msgs.concat([{role:"user", text:userText, files:doneFiles}]);
    setMsgs(newMsgs); setLoading(true);

    var fcText = fileCtxs.length
      ? "\n\nFILE CONTEXT:\n" + fileCtxs.map(function(f){ return "["+f.name+"]:\n"+f.content.slice(0,800); }).join("\n\n")
      : "";

    var empJson = JSON.stringify(emps.map(function(e){ return {id:e.id,name:e.name,role:e.role,dept:e.dept,seniority:e.seniority,location:e.location,knowledge:e.knowledge}; }));
    var sys = "You identify which employees to interview to answer business questions.\n\nEmployees:\n" + empJson + fcText +
      "\n\nReturn ONLY valid JSON: {\"analysis\":\"...\",\"employees\":[{\"id\":1,\"name\":\"...\",\"role\":\"...\",\"location\":\"...\",\"seniority\":\"...\",\"relevance\":\"...\",\"insight\":\"...\",\"confidence\":90}]}";

    var qForAI = q || "Based on uploaded files, who should we interview?";
    if (doneFiles.length) qForAI += " Files: " + doneFiles.map(function(f){ return f.name; }).join(", ");

    try {
      var raw = await ai([{role:"user",content:qForAI}], sys);
      var clean = raw.replace(/```json/g,"").replace(/```/g,"").trim();
      var parsed = JSON.parse(clean);
      setRecs(parsed.employees || []);
      setMsgs(function(p){ return p.concat([{role:"assistant",text:parsed.analysis||"Here are my recommendations.",recs:parsed.employees}]); });
    } catch(e) {
      setMsgs(function(p){ return p.concat([{role:"assistant",text:"I identified the best employees to interview based on your question."}]); });
    }
    setLoading(false);
  }

  function toggleSel(emp) {
    setSel(function(p){
      return p.find(function(s){ return s.id===emp.id; })
        ? p.filter(function(s){ return s.id!==emp.id; })
        : p.concat([emp]);
    });
  }

  function addManual(emp) {
    // Add directly to sel
    setSel(function(p){
      if (p.find(function(s){ return s.id===emp.id; })) return p;
      return p.concat([emp]);
    });
    setShowAdd(false);
  }

  return (
    <div style={{fontFamily:"'DM Sans','Helvetica Neue',sans-serif",height:"100vh",
      display:"flex",flexDirection:"column",background:"#F9FAFB"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Serif+Display&display=swap" rel="stylesheet" />
      <div style={{background:"#fff",borderBottom:"1px solid #E5E7EB",padding:"0 32px",height:56,
        display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        <button onClick={onBack}
          style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:"#6B7280",padding:0,marginRight:4}}>
          back
        </button>
        <Logo size={26} />
        <span style={{fontSize:15,fontWeight:600,color:"#111827"}}>Gaura</span>
        <span style={{fontSize:11,color:"#6B7280",background:"#F3F4F6",padding:"2px 8px",borderRadius:10}}>Explore</span>
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",maxWidth:780,
        width:"100%",margin:"0 auto",padding:"0 24px",boxSizing:"border-box"}}>

        <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:"24px 0 8px"}}>
          {msgs.length===0 && (
            <div style={{textAlign:"center",paddingTop:60}}>
              <p style={{fontFamily:"'DM Serif Display',serif",fontSize:24,color:"#111827",margin:"0 0 8px"}}>What do you need to understand?</p>
              <p style={{fontSize:14,color:"#6B7280",margin:0}}>Ask a question or attach employee files.</p>
            </div>
          )}
          {msgs.map(function(m,i) {
            return (
              <div key={i} style={{display:"flex",gap:10,marginBottom:20,alignItems:"flex-start"}}>
                {m.role==="assistant"
                  ? <div style={{width:28,height:28,borderRadius:7,background:"#1a1a2e",
                      display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <span style={{color:"#fff",fontSize:10,fontWeight:700}}>G</span>
                    </div>
                  : <div style={{width:28,height:28,borderRadius:"50%",background:"#DBEAFE",
                      display:"flex",alignItems:"center",justifyContent:"center",
                      fontSize:11,fontWeight:600,color:"#1D4ED8",flexShrink:0}}>
                      U
                    </div>
                }
                <div style={{flex:1}}>
                  <p style={{fontSize:11.5,fontWeight:600,color:"#9CA3AF",margin:"0 0 5px"}}>
                    {m.role==="assistant"?"Gaura":"You"}
                  </p>
                  {m.files && m.files.length>0 && (
                    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
                      {m.files.map(function(f,fi){
                        var mt=fmeta(f.name);
                        return <span key={fi} style={{display:"inline-flex",alignItems:"center",gap:3,
                          fontSize:11,color:mt.color,background:mt.bg,
                          border:"1px solid "+mt.color+"33",borderRadius:5,padding:"2px 8px",fontWeight:600}}>
                          {mt.label} {f.name}
                        </span>;
                      })}
                    </div>
                  )}
                  <div style={{background:m.role==="assistant"?"#fff":"#EFF6FF",
                    border:"1px solid "+(m.role==="assistant"?"#E5E7EB":"#BFDBFE"),
                    borderRadius:12,padding:"10px 14px",display:"inline-block",maxWidth:"100%"}}>
                    <p style={{fontSize:14,color:"#111827",margin:0,lineHeight:1.75}}>{m.text}</p>
                  </div>
                  {m.recs && m.recs.length>0 && recs && (
                    <div style={{marginTop:10}}>
                      <p style={{fontSize:11,color:"#6B7280",margin:"0 0 6px",fontWeight:500}}>Recommended employees:</p>
                      {m.recs.slice(0,4).map(function(r,ri){
                        var isSel = sel.find(function(s){ return s.id===r.id; });
                        return (
                          <div key={ri} style={{display:"flex",alignItems:"center",gap:8,
                            background:"#fff",border:"1px solid "+(isSel?"#6EE7B7":"#E5E7EB"),
                            borderRadius:8,padding:"8px 12px",marginBottom:6}}>
                            <Av initials={(emps.find(function(e){ return e.id===r.id; })||{}).initials||(r.name||"?").slice(0,2)} size={28} idx={ri} />
                            <div style={{flex:1}}>
                              <span style={{fontSize:13,fontWeight:600,color:"#111827"}}>{r.name}</span>
                              <span style={{fontSize:12,color:"#6B7280",marginLeft:6}}>{r.role}</span>
                            </div>
                            {r.confidence && <Conf score={r.confidence} />}
                            <button onClick={function(){ toggleSel(r); }}
                              style={{background:isSel?"#1a1a2e":"transparent",color:isSel?"#fff":"#374151",
                                border:"1px solid "+(isSel?"#1a1a2e":"#E5E7EB"),borderRadius:6,
                                padding:"4px 10px",fontSize:11,cursor:"pointer",fontWeight:500}}>
                              {isSel?"Selected":"Select"}
                            </button>
                          </div>
                        );
                      })}
                      <button onClick={function(){ setShowAdd(true); }}
                        style={{fontSize:12,color:"#6B7280",background:"none",border:"1px solid #E5E7EB",
                          borderRadius:6,padding:"5px 11px",cursor:"pointer",marginTop:4}}>
                        + Add person manually
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {loading && (
            <div style={{display:"flex",gap:10,marginBottom:20}}>
              <div style={{width:28,height:28,borderRadius:7,background:"#1a1a2e",
                display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <span style={{color:"#fff",fontSize:10,fontWeight:700}}>G</span>
              </div>
              <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,
                padding:"10px 14px",display:"inline-block"}}>
                <Dots />
              </div>
            </div>
          )}
        </div>

        <div style={{padding:"8px 0 16px",flexShrink:0}}>
          <ChatBar
            value={input} onChange={function(e){ setInput(e.target.value); }}
            onKeyDown={function(e){ if(e.key==="Enter"&&!e.shiftKey&&!loading) send(); }}
            onSend={send} loading={loading}
            placeholder="Ask a business question or attach employee files..."
            files={fu.files} onAddFiles={fu.addFiles} onRemoveFile={fu.remove} />
        </div>
      </div>
      {showAdd && (
      <AddPersonModal
        candidates={(recs||[]).filter(function(r){ return !sel.find(function(s){ return s.id===r.id; }); })}
        onAdd={function(emp){ addManual(emp); }}
        onClose={function(){ setShowAdd(false); }}
      />
    )}
    </div>
  );
}

// ── STORAGE HELPERS ───────────────────────────────────────────────────────────

async function storeSave(key, value) {
  try { await window.storage.set(key, JSON.stringify(value)); } catch(e) {}
}

async function storeLoad(key) {
  try {
    var r = await window.storage.get(key);
    if (r && r.value) return JSON.parse(r.value);
  } catch(e) {}
  return null;
}

async function storeDelete(key) {
  try { await window.storage.delete(key); } catch(e) {}
}

async function storeList(prefix) {
  try {
    var r = await window.storage.list(prefix);
    if (r && r.keys) return r.keys;
  } catch(e) {}
  return [];
}



// ── CAMPAIGN ──────────────────────────────────────────────────────────────────

function Campaign(props) {
  var init = props.init;
  var onBack = props.onBack;
  var onSave = props.onSave; // callback to update campaigns list in App

  var SKEY = "campaign-" + init.id;

  var initStatus = {
    setup:"in_progress", conduct:"not_started",
    live:"not_started", insights:"not_started"
  };

  var [loaded, setLoaded] = useState(false);
  var [emps, setEmps] = useState([]);
  var [fileCtxs, setFileCtxs] = useState([]);
  var [q, setQ] = useState(init.q || "");
  var [recs, setRecs] = useState(init.recs || []);
  var [sel, setSel] = useState(init.sel || []);
  var [guides, setGuides] = useState(init.guides || {});
  var defaultCfg = {mode:"Text",depth:"Deep",length:"standard",tone:"Conversational"};
  var [cfgs, setCfgs] = useState(init.cfgs || {});
  var [editingGuide, setEditingGuide] = useState(null);
  var [telegramSessions, setTelegramSessions] = useState({});
  var [telegramBotUrl, setTelegramBotUrl] = useState(
    typeof window !== "undefined" ? (localStorage.getItem("gaura_bot_url")||"") : ""
  );
  var [stepStatus, setStepStatus] = useState(init.stepStatus || initStatus);
  var [summary, setSummary] = useState(init.summary || null);
  var [activePanel, setActivePanel] = useState(init.activePanel || "setup");
  var [activeGuide, setActiveGuide] = useState(null);
  var [msgs, setMsgs] = useState(init.msgs || []);
  var [input, setInput] = useState("");
  var [loading, setLoading] = useState(false);
  var [guidesLoading, setGuidesLoading] = useState(false);
  var [summaryLoading, setSummaryLoading] = useState(false);
  var [showAdd, setShowAdd] = useState(false);
  var [saveStatus, setSaveStatus] = useState("saved"); // "saved" | "saving" | "error"
  var chatRef = useRef(null);
  var saveTimer = useRef(null);

  // Load from storage on mount
  useEffect(function() {
    async function load() {
      var saved = await storeLoad(SKEY);
      if (saved) {
        if (saved.q) setQ(saved.q);
        if (saved.recs) setRecs(saved.recs);
        if (saved.sel) setSel(saved.sel);
        if (saved.guides) setGuides(saved.guides);
        if (saved.cfgs) setCfgs(saved.cfgs);
        if (saved.stepStatus) setStepStatus(saved.stepStatus);
        if (saved.summary) setSummary(saved.summary);
        if (saved.activePanel) setActivePanel(saved.activePanel);

        if (saved.msgs && saved.msgs.length > 0) setMsgs(saved.msgs);
      } else {
        // Brand new campaign — show greeting
        setMsgs([{role:"assistant", text:"Campaign \"" + init.name + "\" created. What business question are you investigating?\n\nYou can also attach employee files using the paperclip icon."}]);
      }
      setLoaded(true);
    }
    load();
  }, []);

  // Auto-save whenever key state changes (debounced 800ms)
  function scheduleSave(state) {
    if (!loaded) return;
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async function() {
      await storeSave(SKEY, state);
      // Also update the campaign index
      if (onSave) onSave(init.id, state);
      setSaveStatus("saved");
    }, 800);
  }

  // Build current state snapshot
  function snapshot(overrides) {
    return Object.assign({
      q: q, recs: recs, sel: sel, guides: guides, cfgs: cfgs,
      stepStatus: stepStatus, summary: summary,
      activePanel: activePanel,
      msgs: msgs.slice(-60),
    }, overrides || {});
  }

  var fu = useFiles(
    function(newEmps){ setEmps(function(p){ return p.concat(newEmps); }); },
    function(ctx){
      setFileCtxs(function(p){ return p.concat([ctx]); });
      var msg = ctx.employees && ctx.employees.length > 0
        ? "Processed \"" + ctx.name + "\". Found " + ctx.employees.length + " employees added to the database."
        : "Processed \"" + ctx.name + "\". Content added as context for this campaign.";
      setMsgs(function(p) {
        var next = p.concat([{role:"assistant", text:msg}]);
        scheduleSave(snapshot({msgs: next.slice(-60)}));
        return next;
      });
    }
  );

  useEffect(function(){
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [msgs, loading]);

  function setSt(id, s) {
    setStepStatus(function(prev) {
      var next = Object.assign({}, prev, {[id]:s});
      scheduleSave(snapshot({stepStatus: next}));
      return next;
    });
  }

  async function send() {
    var txt = input.trim();
    var doneFiles = fu.files.filter(function(f){ return f.status==="done"; });
    if (!txt && !doneFiles.length) return;
    setInput(""); fu.clear();

    var userText = txt || ("Uploaded: " + doneFiles.map(function(f){ return f.name; }).join(", "));
    var newMsgs = msgs.concat([{role:"user", text:userText, files:doneFiles.map(function(f){ return {name:f.name}; })}]);
    setMsgs(newMsgs);
    setLoading(true);

    var curQ = q;
    var newStatus = Object.assign({}, stepStatus);

    if (!curQ && txt) {
      curQ = txt;
      setQ(txt);
      newStatus.setup = "complete";
      setStepStatus(newStatus);
      setActivePanel("setup");
    }

    var fcText = fileCtxs.length
      ? "\n\nUPLOADED FILES:\n" + fileCtxs.map(function(f){ return "["+f.name+"]: "+f.content.slice(0,500); }).join("\n")
      : "";

    var empJson = JSON.stringify(emps.map(function(e){
      return {id:e.id,name:e.name,role:e.role,dept:e.dept,seniority:e.seniority,location:e.location,knowledge:e.knowledge};
    }));

    var sys = "You are Gaura, guiding an executive through an interview campaign.\n"
      + "Campaign: \"" + init.name + "\"\n"
      + "Business question: \"" + (curQ||"not yet defined") + "\"\n"
      + "Employees:\n" + empJson + fcText + "\n"
      + "State: brief=" + (curQ?"set":"unset") + ", recommended=" + recs.length + ", selected=" + sel.length + "\n\n"
      + "When asked for employee recommendations, embed JSON in your reply:\n"
      + "<recs>{\"analysis\":\"...\",\"employees\":[{\"id\":1,\"name\":\"...\",\"role\":\"...\",\"location\":\"...\",\"seniority\":\"...\",\"relevance\":\"...\",\"insight\":\"...\",\"confidence\":90}]}</recs>\n"
      + "You have access to web search. If the user shares a URL or asks about a website, search or fetch it to extract context for the campaign — e.g. company info, job descriptions, org structure. Then use that context to recommend interviewees and build better guides. Otherwise reply in 2-4 sentences. Guide toward the next action.";

    var api = newMsgs.map(function(m){
      return {role:m.role==="assistant"?"assistant":"user", content:m.text};
    });

    try {
      // Use web search tool so the agent can fetch URLs shared in chat
      var raw = await aiWithSearch(api, sys);
      var rm = raw.match(/<recs>([\s\S]*?)<\/recs>/);
      if (rm) {
        var clean = rm[1].replace(/```json/g,"").replace(/```/g,"").trim();
        var parsed = JSON.parse(clean);
        var newRecs = parsed.employees || [];
        var textPart = raw.replace(/<recs>[\s\S]*?<\/recs>/,"").trim();
        var aiMsg = {role:"assistant", text:textPart || parsed.analysis || "Here are my recommendations.", recs:newRecs};
        var finalMsgs = newMsgs.concat([aiMsg]);
        newStatus.setup = "complete";
        setRecs(newRecs);
        setStepStatus(newStatus);
        setActivePanel("setup");
        setMsgs(finalMsgs);
        scheduleSave(snapshot({q:curQ, recs:newRecs, stepStatus:newStatus, activePanel:"setup", msgs:finalMsgs.slice(-60)}));
      } else {
        var finalMsgs2 = newMsgs.concat([{role:"assistant", text:raw}]);
        setMsgs(finalMsgs2);
        scheduleSave(snapshot({q:curQ, stepStatus:newStatus, msgs:finalMsgs2.slice(-60)}));
      }
    } catch(e) {
      var errMsgs = newMsgs.concat([{role:"assistant", text:"Ready to help. What would you like to do next?"}]);
      setMsgs(errMsgs);
    }
    setLoading(false);
  }

  function toggleSel(emp) {
    setSel(function(p){
      var has = p.find(function(s){ return s.id===emp.id; });
      var next = has ? p.filter(function(s){ return s.id!==emp.id; }) : p.concat([emp]);
      var newSt = Object.assign({}, stepStatus, {setup: next.length>0?"complete":"in_progress"});
      setStepStatus(newSt);
      scheduleSave(snapshot({sel:next, stepStatus:newSt}));
      return next;
    });
  }

  function addManual(emp) {
    // emp is already in recs — just add to sel
    setSel(function(p) {
      if (p.find(function(s){ return s.id===emp.id; })) return p;
      var next = p.concat([emp]);
      var newSt = Object.assign({}, stepStatus, {setup:"complete"});
      setStepStatus(newSt);
      scheduleSave(snapshot({sel:next, stepStatus:newSt}));
      return next;
    });
  }

  async function genGuides() {
    if (!sel.length) return;
    // Only generate for employees who don't already have a guide
    var missing = sel.filter(function(emp){ return !guides[emp.id]; });
    if (!missing.length) {
      // All guides already exist — just navigate
      setActiveGuide(sel[0] ? sel[0].id : null);
      setActivePanel("conduct");
      return;
    }
    setGuidesLoading(true);
    setSt("conduct","in_progress");
    setActivePanel("conduct");
    // Start with existing guides and merge in new ones
    var g = Object.assign({}, guides);
    for (var i=0; i<missing.length; i++) {
      var emp = missing[i];
      try {
        var gq = "Business question: \"" + (q||init.name) + "\"\n"
          + "Employee: " + emp.name + ", " + emp.role + ", " + (emp.dept||"") + ", " + emp.location + "\n"
          + "Knowledge: " + (emp.knowledge||[]).join(", ") + "\n\n"
          + "Return ONLY JSON: {\"objective\":\"...\",\"topics\":[\"...\",\"...\",\"...\",\"...\"],\"questions\":[\"...\",\"...\",\"...\",\"...\",\"...\",\"...\"],\"followups\":[\"...\",\"...\",\"...\"],\"expected_insights\":\"...\"}";
        var raw = await ai([{role:"user",content:gq}], "Generate interview guides. Return only valid JSON, no markdown.");
        g[emp.id] = JSON.parse(raw.replace(/```json/g,"").replace(/```/g,"").trim());
      } catch(e2) {
        g[emp.id] = {
          objective: "Understand " + emp.name + "'s direct perspective on: " + (q||init.name),
          topics:["Current challenges","Root causes","Process gaps","Resource constraints"],
          questions:["Walk me through the main challenges you are seeing?","How long has this been building, and what triggered it?","Give me a specific example where this caused a real problem?","What has been tried so far, and why has it not worked?","What would need to change for this to improve?","If you were in charge, what would you do first?"],
          followups:["Escalation history","Cross-team dependencies","Prior improvement attempts"],
          expected_insights: emp.name + " should surface root causes not visible from data alone."
        };
      }

    }
    setGuides(g);
    setActiveGuide(sel[0] ? sel[0].id : null);
    var newSt = Object.assign({}, stepStatus, {setup:"complete", conduct:"complete"});
    setStepStatus(newSt);
    setGuidesLoading(false);
    var count = missing.length;
    var guideMsg = {role:"assistant", text:"Interview guide" + (count>1?"s":"") + " generated for " + count + " employee" + (count>1?"s":"") + ". Review and edit the guides on the right, then configure and launch."};
    setMsgs(function(p) {
      var next = p.concat([guideMsg]);
      scheduleSave(snapshot({guides:g, stepStatus:newSt, activePanel:"conduct", msgs:next.slice(-60)}));
      return next;
    });
    setActivePanel("conduct");
  }

  async function onInterviewDone(imsgs) {
    var newSt = Object.assign({}, stepStatus, {live:"complete", insights:"in_progress"});
    setStepStatus(newSt);
    setActivePanel("summaries");
    setSummaryLoading(true);
    var person = sel[0] || {name:"Employee",role:"Unknown"};
    var transcript = imsgs.map(function(m){
      return (m.role==="ai"?"Interviewer":person.name) + ": " + m.text;
    }).join("\n\n");
    var sp = "Interviewee: " + person.name + ", " + person.role + "\n"
      + "Question: \"" + q + "\"\n"
      + "Transcript:\n" + transcript + "\n\n"
      + "Return ONLY JSON: {\"summary\":\"...\",\"insights\":[{\"title\":\"...\",\"detail\":\"...\"}],\"risks\":[\"...\"],\"opportunities\":[\"...\"],\"actions\":[{\"action\":\"...\",\"owner\":\"...\",\"timeline\":\"...\"}],\"confidence\":87}";
    var newSummary;
    try {
      var raw = await ai([{role:"user",content:sp}], "Generate executive interview insight reports. Return only valid JSON.");
      newSummary = JSON.parse(raw.replace(/```json/g,"").replace(/```/g,"").trim());
    } catch(e) {
      newSummary = {
        summary: "Interview with " + person.name + " surfaced key issues related to: " + q,
        insights:[
          {title:"Root cause identified",detail:"Structural issues emerged as primary drivers."},
          {title:"Process gaps",detail:"Coordination and handover processes need attention."},
          {title:"Resource constraints",detail:"Capacity issues compound operational challenges."},
          {title:"Quick wins available",detail:"Some fixes require only enforcement of existing standards."}
        ],
        risks:["Issue persists without structural intervention","Talent attrition risk if unaddressed","Customer impact will compound over time"],
        opportunities:["Process standardisation achievable quickly","Existing tools under-utilised","Cross-team alignment possible with clear mandate"],
        actions:[
          {action:"Address root cause with immediate task force",owner:"COO",timeline:"2 weeks"},
          {action:"Standardise processes across all regions",owner:"Ops Director",timeline:"30 days"},
          {action:"Weekly monitoring until resolved",owner:"Leadership",timeline:"Ongoing"}
        ],
        confidence:82
      };
    }
    setSummary(newSummary);
    setSummaryLoading(false);
    var finalSt = Object.assign({}, newSt, {summaries:"complete", report:"complete"});
    setStepStatus(finalSt);
    var reportMsg = {role:"assistant", text:"Insight report is ready. Review the executive summary, key findings, risks, and recommended actions on the right."};
    setMsgs(function(p) {
      var next = p.concat([reportMsg]);
      scheduleSave(snapshot({summary:newSummary, stepStatus:finalSt, activePanel:"insights", msgs:next.slice(-60)}));
      return next;
    });
    setActivePanel("insights");
  }

  var selFull = sel.map(function(s){ return emps.find(function(e){ return e.id===s.id; })||s; });
  var doneCount = Object.values(stepStatus).filter(function(v){ return v==="complete"; }).length;

  // ── RIGHT PANEL CONTENT ────────────────────────────────────────────────────

  // ── PANEL: Brief & Interviewees ───────────────────────────────────────────

  function PanelSetup() {
    return (
      <div>
        {/* Brief */}
        <h2 style={{fontSize:16,fontWeight:600,color:"#111827",margin:"0 0 4px"}}>Campaign brief</h2>
        <p style={{fontSize:13,color:"#6B7280",margin:"0 0 14px"}}>Define the business question, then select who to interview.</p>

        {q ? (
          <div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,
            padding:"14px 16px",marginBottom:24}}>
            <p style={{fontSize:11,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.5,margin:"0 0 6px"}}>Business question</p>
            <p style={{fontSize:14,color:"#111827",margin:0,lineHeight:1.65}}>{q}</p>
          </div>
        ) : (
          <div style={{background:"#EFF6FF",border:"1.5px dashed #BFDBFE",borderRadius:10,
            padding:"14px 16px",marginBottom:24}}>
            <p style={{fontSize:13,color:"#2563EB",margin:0,lineHeight:1.6}}>
              Type your business question in the chat to get started.
            </p>
          </div>
        )}

        {/* Interviewees */}
        {recs.length > 0 && (
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <h3 style={{fontSize:14,fontWeight:600,color:"#111827",margin:0}}>
                Interviewees
                <span style={{fontSize:12,fontWeight:400,color:"#9CA3AF",marginLeft:8}}>
                  {sel.length} of {recs.length} selected
                </span>
              </h3>
              <button onClick={function(){ setShowAdd(true); }}
                style={{fontSize:12,color:"#374151",background:"#fff",border:"1px solid #E5E7EB",
                  borderRadius:7,padding:"5px 12px",cursor:"pointer",fontWeight:500}}>
                + Add manually
              </button>
            </div>

            {recs.map(function(rec,i) {
              var isSel = sel.find(function(s){ return s.id===rec.id; });
              return (
                <div key={rec.id||i} style={{background:"#fff",borderRadius:10,padding:"11px 14px",marginBottom:7,
                  border:"1px solid "+(isSel?"#6EE7B7":"#F3F4F6"),
                  boxShadow:"0 1px 2px rgba(0,0,0,0.04)"}}>
                  <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                    <Av initials={(emps.find(function(e){ return e.id===rec.id; })||{}).initials||(rec.name||"?").slice(0,2)} size={32} idx={i} />
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:1}}>
                        <span style={{fontSize:13,fontWeight:600,color:"#111827"}}>{rec.name}</span>
                        {rec.confidence && <Conf score={rec.confidence} />}
                        {rec.manual && <span style={{fontSize:10,color:"#92400E",background:"#FEF3C7",padding:"2px 6px",borderRadius:10,fontWeight:500}}>Manual</span>}
                      </div>
                      <p style={{fontSize:12,color:"#6B7280",margin:"0 0 3px"}}>{rec.role}{rec.location ? " - " + rec.location : ""}</p>
                      {rec.relevance && (
                        <p style={{fontSize:11,color:"#374151",margin:0,lineHeight:1.5,fontStyle:"italic"}}>
                          {rec.relevance}
                        </p>
                      )}
                    </div>
                    <button onClick={function(){ toggleSel(rec); }}
                      style={{flexShrink:0,background:isSel?"#F0FDF4":"transparent",
                        color:isSel?"#0F6E56":"#6B7280",
                        border:"1px solid "+(isSel?"#6EE7B7":"#E5E7EB"),
                        borderRadius:7,padding:"5px 12px",fontSize:12,cursor:"pointer",fontWeight:500}}>
                      {isSel ? "Remove" : "Select"}
                    </button>
                  </div>
                </div>
              );
            })}

            {sel.length > 0 && (
              <div style={{marginTop:14}}>
                {(function(){
                  var missing = sel.filter(function(s){ return !guides[s.id]; });
                  if (missing.length > 0) {
                    return (
                      <button onClick={genGuides} disabled={guidesLoading}
                        style={{background:"#1a1a2e",color:"#fff",border:"none",borderRadius:8,
                          padding:"10px 18px",fontSize:13,fontWeight:500,cursor:"pointer",
                          opacity:guidesLoading?0.6:1,width:"100%"}}>
                        {guidesLoading ? "Generating..." : "Generate interview guides"}
                      </button>
                    );
                  }
                  return (
                    <button onClick={function(){ setActiveGuide(sel[0]?sel[0].id:null); setActivePanel("conduct"); }}
                      style={{background:"#1a1a2e",color:"#fff",border:"none",borderRadius:8,
                        padding:"10px 18px",fontSize:13,fontWeight:500,cursor:"pointer",width:"100%"}}>
                      View guides and configure interviews
                    </button>
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── PANEL: Interviews (guide edit + config + launch per person) ─────────────

  function PanelConduct() {
    var CONFIG_OPTS = [
      {label:"Mode",  key:"mode", opts:["Voice","Text"]},
      {label:"Depth", key:"depth",opts:["Broad","Deep"]},
      {label:"Tone",  key:"tone", opts:["Formal","Conversational","Friendly"]},
    ];

    var LENGTH_OPTS = [
      {value:"short",    label:"Short",    sub:"~5 questions",  topics:"2 topics"},
      {value:"standard", label:"Standard", sub:"~10 questions", topics:"3 topics"},
      {value:"thorough", label:"Thorough", sub:"~15 questions", topics:"4 topics"},
    ];

    function getCfg(empId) {
      return cfgs[empId] || defaultCfg;
    }

    function setEmpCfg(empId, key, val) {
      var newCfgs = Object.assign({}, cfgs, {[empId]: Object.assign({}, getCfg(empId), {[key]:val})});
      setCfgs(newCfgs);
      scheduleSave(snapshot({cfgs:newCfgs}));
    }



    if (selFull.length === 0) {
      return (
        <div>
          <h2 style={{fontSize:16,fontWeight:600,color:"#111827",margin:"0 0 12px"}}>Interviews</h2>
          <div style={{background:"#EFF6FF",border:"1.5px dashed #BFDBFE",borderRadius:10,padding:"14px 16px"}}>
            <p style={{fontSize:13,color:"#2563EB",margin:0}}>Select interviewees in Brief and Interviewees first.</p>
          </div>
        </div>
      );
    }

    return (
      <div>
        <h2 style={{fontSize:16,fontWeight:600,color:"#111827",margin:"0 0 4px"}}>Interviews</h2>
        <p style={{fontSize:13,color:"#6B7280",margin:"0 0 20px"}}>Edit the guide, configure, and launch for each interviewee.</p>

        {selFull.map(function(emp,i) {
          var g = guides[emp.id];
          var c = getCfg(emp.id);
          var isEditing = editingGuide === emp.id;

          return (
            <div key={emp.id} style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,marginBottom:16,overflow:"hidden"}}>

              {/* Person header */}
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"#FAFAFA",borderBottom:"1px solid #F3F4F6"}}>
                <Av initials={emp.initials} size={32} idx={i} />
                <div style={{flex:1}}>
                  <p style={{fontSize:13,fontWeight:600,color:"#111827",margin:0}}>{emp.name}</p>
                  <p style={{fontSize:12,color:"#6B7280",margin:0}}>{emp.role}</p>
                </div>
              </div>

              <div style={{padding:"16px"}}>

                {/* Guide section */}
                {!g ? (
                  <div style={{background:"#FEF3C7",border:"1px solid #FDE68A",borderRadius:8,padding:"12px 14px",marginBottom:14}}>
                    <p style={{fontSize:12,fontWeight:500,color:"#92400E",margin:"0 0 6px"}}>No guide yet for {emp.name}.</p>
                    <button onClick={genGuides} disabled={guidesLoading}
                      style={{background:"#D97706",color:"#fff",border:"none",borderRadius:7,
                        padding:"7px 14px",fontSize:12,fontWeight:500,cursor:"pointer",opacity:guidesLoading?0.6:1}}>
                      {guidesLoading ? "Generating..." : "Generate guide"}
                    </button>
                  </div>
                ) : isEditing ? (
                  <div style={{marginBottom:14}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                      <p style={{fontSize:12,fontWeight:600,color:"#374151",margin:0}}>Editing guide</p>
                      <button onClick={function(){ setEditingGuide(null); }}
                        style={{fontSize:12,color:"#0F6E56",background:"none",border:"none",cursor:"pointer",fontWeight:500}}>
                        Done editing
                      </button>
                    </div>

                    <p style={{fontSize:10,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.5,margin:"0 0 5px"}}>Objective</p>
                    <textarea
                      value={g.objective||""}
                      onChange={function(e){
                        var newG = Object.assign({},guides,{[emp.id]: Object.assign({},g,{objective:e.target.value})});
                        setGuides(newG);
                        scheduleSave(snapshot({guides:newG}));
                      }}
                      rows={2}
                      style={{width:"100%",boxSizing:"border-box",border:"1px solid #E5E7EB",borderRadius:7,
                        padding:"8px 10px",fontSize:12,fontFamily:"inherit",resize:"vertical",
                        color:"#374151",background:"#F9FAFB",outline:"none",marginBottom:10}}
                    />

                    <p style={{fontSize:10,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.5,margin:"0 0 6px"}}>Questions</p>
                    {(g.questions||[]).map(function(qq,qi){
                      return (
                        <div key={qi} style={{display:"flex",gap:6,marginBottom:6,alignItems:"flex-start"}}>
                          <span style={{fontSize:11,color:"#9CA3AF",fontWeight:600,minWidth:22,paddingTop:8}}>Q{qi+1}</span>
                          <textarea
                            value={qq}
                            rows={2}
                            onChange={function(e){
                              var newQs = (g.questions||[]).slice();
                              newQs[qi] = e.target.value;
                              var newG = Object.assign({},guides,{[emp.id]: Object.assign({},g,{questions:newQs})});
                              setGuides(newG);
                              scheduleSave(snapshot({guides:newG}));
                            }}
                            style={{flex:1,border:"1px solid #E5E7EB",borderRadius:7,padding:"7px 10px",
                              fontSize:12,fontFamily:"inherit",resize:"vertical",color:"#374151",
                              background:"#F9FAFB",outline:"none"}}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{marginBottom:14}}>
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:8}}>
                      <p style={{fontSize:12,color:"#374151",margin:0,lineHeight:1.55,fontStyle:"italic",flex:1}}>{g.objective}</p>
                      <button onClick={function(){ setEditingGuide(emp.id); }}
                        style={{fontSize:12,color:"#6B7280",background:"none",border:"1px solid #E5E7EB",
                          borderRadius:6,padding:"4px 10px",cursor:"pointer",flexShrink:0,fontWeight:400}}>
                        Edit guide
                      </button>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:4}}>
                      {(g.questions||[]).map(function(qq,qi){
                        return (
                          <div key={qi} style={{padding:"7px 10px",background:"#F9FAFB",borderRadius:6,
                            display:"flex",gap:8,border:"1px solid #F3F4F6"}}>
                            <span style={{fontSize:10,color:"#9CA3AF",fontWeight:600,minWidth:18,marginTop:1}}>Q{qi+1}</span>
                            <span style={{fontSize:12,color:"#374151",lineHeight:1.5}}>{qq}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Config */}
                <div style={{borderTop:"1px solid #F3F4F6",paddingTop:14,marginBottom:14}}>
                  <p style={{fontSize:10,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.5,margin:"0 0 12px"}}>Configuration</p>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
                    {CONFIG_OPTS.map(function(item){
                      return (
                        <div key={item.key}>
                          <p style={{fontSize:10,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.4,margin:"0 0 5px"}}>{item.label}</p>
                          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                            {item.opts.map(function(o){
                              var isA = c[item.key]===o;
                              return (
                                <button key={o} onClick={function(){ setEmpCfg(emp.id, item.key, o); }}
                                  style={{padding:"4px 10px",borderRadius:6,fontSize:11,cursor:"pointer",
                                    border:"1px solid "+(isA?"#1a1a2e":"#E5E7EB"),
                                    background:isA?"#1a1a2e":"transparent",
                                    color:isA?"#fff":"#374151"}}>
                                  {o}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Interview length */}
                  <div style={{gridColumn:"1 / -1"}}>
                    <p style={{fontSize:10,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.4,margin:"0 0 8px"}}>Interview length</p>
                    <div style={{display:"flex",gap:8}}>
                      {LENGTH_OPTS.map(function(opt){
                        var isA = (c.length||"standard")===opt.value;
                        return (
                          <button key={opt.value} onClick={function(){ setEmpCfg(emp.id,"length",opt.value); }}
                            style={{flex:1,padding:"10px 8px",borderRadius:8,cursor:"pointer",textAlign:"center",
                              border:"1px solid "+(isA?"#1a1a2e":"#E5E7EB"),
                              background:isA?"#1a1a2e":"transparent"}}>
                            <div style={{fontSize:13,fontWeight:600,color:isA?"#fff":"#111827",marginBottom:2}}>{opt.label}</div>
                            <div style={{fontSize:11,color:isA?"rgba(255,255,255,0.7)":"#6B7280"}}>{opt.sub}</div>
                            <div style={{fontSize:10,color:isA?"rgba(255,255,255,0.5)":"#9CA3AF"}}>{opt.topics}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                </div>

                {/* Launch — two options */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:0}}>
                  <button onClick={function(){
                    var newSt = Object.assign({},stepStatus,{conduct:"complete",live:"in_progress"});
                    setStepStatus(newSt);
                    setActivePanel("live");
                    setMsgs(function(p){
                      var next = p.concat([{role:"assistant",text:"Interview launched with " + emp.name + " in-app."}]);
                      scheduleSave(snapshot({stepStatus:newSt,activePanel:"live",msgs:next.slice(-60)}));
                      return next;
                    });
                  }}
                    style={{background:"#16A34A",color:"#fff",border:"none",borderRadius:8,
                      padding:"10px 12px",fontSize:12,fontWeight:600,cursor:"pointer",
                      display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="white" stroke="none"/></svg>
                    Launch in-app
                  </button>
                  <button onClick={function(){
                    var empCfg = getCfg(emp.id);
                    var empGuide = guides[emp.id] || {};
                    var botUrl = telegramBotUrl || prompt("Enter your Gaura bot URL (e.g. https://gaura-bot.up.railway.app):");
                    if (!botUrl) return;
                    if (!telegramBotUrl) {
                      setTelegramBotUrl(botUrl);
                      try { localStorage.setItem("gaura_bot_url", botUrl); } catch(e2){}
                    }
                    var payload = {
                      campaign_id: String(init.id),
                      interviewee_name: emp.name,
                      interviewee_role: emp.role,
                      guide: empGuide,
                      config: empCfg,
                      mode: "group"
                    };
                    fetch(botUrl + "/create-session", {
                      method:"POST",
                      headers:{"Content-Type":"application/json"},
                      body:JSON.stringify(payload)
                    }).then(function(r){ return r.json(); }).then(function(data){
                      var sid = data.session_id;
                      var setupCmd = data.setup_command;
                      var instructions = data.instructions;
                      setTelegramSessions(function(prev){
                        return Object.assign({},prev,{[emp.id]:{session_id:sid,setup_command:setupCmd,instructions:instructions}});
                      });
                      setMsgs(function(p){
                        var next = p.concat([{role:"assistant",text:"Telegram session created for " + emp.name + ". See the Interviews panel for the setup instructions."}]);
                        scheduleSave(snapshot({msgs:next.slice(-60)}));
                        return next;
                      });
                    }).catch(function(err){
                      alert("Could not reach the bot server. Check the URL and try again.");
                    });
                  }}
                    style={{background:"#0088CC",color:"#fff",border:"none",borderRadius:8,
                      padding:"10px 12px",fontSize:12,fontWeight:600,cursor:"pointer",
                      display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8l-1.68 7.92c-.12.56-.48.7-.96.44l-2.68-1.98-1.28 1.24c-.14.14-.28.18-.56.18l.2-2.84 5.16-4.68c.22-.2-.06-.3-.36-.1L7.6 14.2l-2.64-.82c-.56-.18-.58-.56.12-.82l10.36-4c.48-.16.88.12.72.8-.01 0-.01.02-.02.02z"/></svg>
                    Send via Telegram
                  </button>
                </div>

                {/* Telegram session card */}
                {telegramSessions[emp.id] && (
                  <div style={{marginTop:10,background:"#E8F4FB",border:"1px solid #BFDBFE",borderRadius:9,padding:"12px 14px"}}>
                    <p style={{fontSize:12,fontWeight:600,color:"#0088CC",margin:"0 0 8px",display:"flex",alignItems:"center",gap:5}}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="#0088CC"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8l-1.68 7.92c-.12.56-.48.7-.96.44l-2.68-1.98-1.28 1.24c-.14.14-.28.18-.56.18l.2-2.84 5.16-4.68c-.22-.2-.06-.3-.36-.1L7.6 14.2l-2.64-.82c-.56-.18-.58-.56.12-.82l10.36-4c.48-.16.88.12.72.8z"/></svg>
                      Telegram session ready
                    </p>
                    <p style={{fontSize:11,color:"#374151",margin:"0 0 6px",lineHeight:1.6,whiteSpace:"pre-line"}}>
                      {telegramSessions[emp.id].instructions}
                    </p>
                    <div style={{background:"#fff",borderRadius:6,padding:"7px 10px",
                      fontFamily:"monospace",fontSize:11,color:"#1a1a2e",
                      border:"1px solid #BFDBFE",marginBottom:6,wordBreak:"break-all"}}>
                      {telegramSessions[emp.id].setup_command}
                    </div>
                    <button onClick={function(){
                      var txt = telegramSessions[emp.id].setup_command;
                      try { navigator.clipboard.writeText(txt); } catch(e2){
                        var el=document.createElement("textarea");el.value=txt;
                        document.body.appendChild(el);el.select();
                        document.execCommand("copy");document.body.removeChild(el);
                      }
                    }}
                      style={{background:"#0088CC",color:"#fff",border:"none",borderRadius:6,
                        padding:"5px 12px",fontSize:11,fontWeight:500,cursor:"pointer"}}>
                      Copy setup command
                    </button>
                  </div>
                )}

              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── PANEL: Live interview ───────────────────────────────────────────────────

  function PanelLive() {
    if (!sel[0]) return <p style={{fontSize:13,color:"#6B7280"}}>No interviewees selected.</p>;
    var empCfg = cfgs[sel[0].id] || defaultCfg;
    var empGuide = guides[sel[0].id] || null;
    return <VoiceInterview config={empCfg} person={sel[0]} question={q||init.name} guide={empGuide} onDone={onInterviewDone} />;
  }

  // ── PANEL: Insights (summary + full report) ────────────────────────────────

  function PanelInsights() {
    if (summaryLoading) {
      return (
        <div style={{textAlign:"center",padding:"40px 20px",color:"#6B7280",fontSize:13}}>
          Generating insight report...
        </div>
      );
    }
    if (!summary) {
      return (
        <div style={{background:"#EFF6FF",border:"1.5px dashed #BFDBFE",borderRadius:10,padding:"14px 16px"}}>
          <p style={{fontSize:13,color:"#2563EB",margin:0}}>Complete the interview to generate the insight report.</p>
        </div>
      );
    }
    return (
      <div>
        <h2 style={{fontSize:16,fontWeight:600,color:"#111827",margin:"0 0 4px"}}>Insights</h2>
        <p style={{fontSize:13,color:"#6B7280",margin:"0 0 20px"}}>
          {(sel[0]||{}).name} - {(sel[0]||{}).role}
          <span style={{marginLeft:8,fontSize:11,color:"#0F6E56",background:"#F0FDF4",padding:"2px 8px",borderRadius:20,fontWeight:500}}>Complete</span>
        </p>

        {/* Executive summary */}
        <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:10,padding:"16px 18px",marginBottom:12}}>
          <p style={{fontSize:11,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.5,margin:"0 0 8px"}}>Executive summary</p>
          <p style={{fontSize:14,color:"#1F2937",margin:"0 0 10px",lineHeight:1.8}}>{summary.summary}</p>
          <span style={{fontSize:12,color:"#0F6E56",fontWeight:500}}>Confidence {summary.confidence}%</span>
        </div>

        {/* Key insights */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
          {(summary.insights||[]).map(function(ins,i){
            return (
              <div key={i} style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:9,padding:"12px 14px"}}>
                <p style={{fontSize:12,fontWeight:600,color:"#111827",margin:"0 0 4px"}}>{ins.title}</p>
                <p style={{fontSize:12,color:"#6B7280",margin:0,lineHeight:1.5}}>{ins.detail}</p>
              </div>
            );
          })}
        </div>

        {/* Risks and opportunities */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
          <div style={{background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:9,padding:"12px 14px"}}>
            <p style={{fontSize:11,fontWeight:600,color:"#991B1B",textTransform:"uppercase",letterSpacing:0.5,margin:"0 0 8px"}}>Risks</p>
            {(summary.risks||[]).map(function(r,i){
              return <p key={i} style={{fontSize:12,color:"#7F1D1D",margin:"0 0 5px",lineHeight:1.4}}>{"! "+r}</p>;
            })}
          </div>
          <div style={{background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:9,padding:"12px 14px"}}>
            <p style={{fontSize:11,fontWeight:600,color:"#14532D",textTransform:"uppercase",letterSpacing:0.5,margin:"0 0 8px"}}>Opportunities</p>
            {(summary.opportunities||[]).map(function(o,i){
              return <p key={i} style={{fontSize:12,color:"#166534",margin:"0 0 5px",lineHeight:1.4}}>{"+ "+o}</p>;
            })}
          </div>
        </div>

        {/* Recommended actions */}
        <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:9,padding:"14px 16px"}}>
          <p style={{fontSize:11,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.5,margin:"0 0 12px"}}>Recommended actions</p>
          {(summary.actions||[]).map(function(a,i){
            return (
              <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start",
                paddingBottom:i<(summary.actions||[]).length-1?10:0,
                marginBottom:i<(summary.actions||[]).length-1?10:0,
                borderBottom:i<(summary.actions||[]).length-1?"1px solid #F3F4F6":"none"}}>
                <div style={{width:20,height:20,borderRadius:"50%",background:"#1a1a2e",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  color:"#fff",fontSize:10,fontWeight:700,flexShrink:0}}>
                  {i+1}
                </div>
                <div>
                  <p style={{fontSize:13,fontWeight:500,color:"#111827",margin:"0 0 2px"}}>{a.action}</p>
                  <p style={{fontSize:11,color:"#6B7280",margin:0}}>{a.owner} - {a.timeline}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderPanel() {
    if (activePanel==="setup")    return <PanelSetup />;
    if (activePanel==="conduct")  return <PanelConduct />;
    if (activePanel==="live")     return <PanelLive />;
    if (activePanel==="insights") return <PanelInsights />;
    return <PanelSetup />;
  }

  var dotC = {not_started:"#D1D5DB",in_progress:"#2563EB",complete:"#16A34A"};

  if (!loaded) {
    return (
      <div style={{fontFamily:"'DM Sans',sans-serif",height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#fff"}}>
        <div style={{textAlign:"center"}}>
          <Logo size={36} />
          <p style={{fontSize:14,color:"#6B7280",marginTop:12}}>Loading campaign...</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{fontFamily:"'DM Sans','Helvetica Neue',sans-serif",height:"100vh",display:"flex",flexDirection:"column",background:"#fff"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Serif+Display&display=swap" rel="stylesheet" />

      <div style={{background:"#1a1a2e",height:46,display:"flex",alignItems:"center",padding:"0 20px",gap:12,flexShrink:0}}>
        <button onClick={onBack}
          style={{background:"none",border:"none",cursor:"pointer",color:"rgba(255,255,255,0.4)",fontSize:13,padding:0,lineHeight:1}}
          onMouseEnter={function(e){ e.currentTarget.style.color="rgba(255,255,255,0.8)"; }}
          onMouseLeave={function(e){ e.currentTarget.style.color="rgba(255,255,255,0.4)"; }}>
          back
        </button>
        <Logo size={22} />
        <span style={{fontSize:13,fontWeight:600,color:"rgba(255,255,255,0.85)"}}>Gaura</span>
        <span style={{color:"rgba(255,255,255,0.15)",fontSize:16,fontWeight:300}}>/</span>
        <span style={{fontSize:13,color:"rgba(255,255,255,0.6)",fontWeight:500}}>{init.name}</span>
        <div style={{flex:1}} />
        <span style={{fontSize:11,color:saveStatus==="saving"?"rgba(255,255,255,0.5)":"rgba(255,255,255,0.25)"}}>
          {saveStatus==="saving" ? "Saving..." : saveStatus==="saved" ? "Saved" : "Save error"}
        </span>
        <span style={{fontSize:11,color:"rgba(255,255,255,0.3)"}}>{doneCount}/{STEPS.length} complete</span>
      </div>

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>

        {/* LEFT — Chat */}
        <div style={{width:"42%",minWidth:320,display:"flex",flexDirection:"column",borderRight:"1px solid #F3F4F6",background:"#fff"}}>
          <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:"24px 20px 8px"}}>
            {msgs.map(function(m,i) {
              var isAI = m.role==="assistant";
              return (
                <div key={i} style={{display:"flex",gap:10,marginBottom:18,alignItems:"flex-start"}}>
                  {isAI
                    ? <div style={{width:26,height:26,borderRadius:7,background:"#1a1a2e",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>
                        <span style={{color:"#fff",fontSize:9,fontWeight:700}}>G</span>
                      </div>
                    : <div style={{width:26,height:26,borderRadius:"50%",background:"#EFF6FF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:600,color:"#2563EB",flexShrink:0,marginTop:1}}>
                        U
                      </div>
                  }
                  <div style={{flex:1}}>
                    <p style={{fontSize:11,fontWeight:600,color:"#9CA3AF",margin:"0 0 5px",letterSpacing:0.2}}>
                      {isAI ? "Gaura" : "You"}
                    </p>
                    {m.files && m.files.length>0 && (
                      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
                        {m.files.map(function(f,fi){
                          var mt = fmeta(f.name);
                          return <span key={fi} style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:11,color:mt.color,background:mt.bg,border:"1px solid "+mt.color+"33",borderRadius:5,padding:"2px 8px",fontWeight:600}}>{mt.label} {f.name}</span>;
                        })}
                      </div>
                    )}
                    <p style={{fontSize:13.5,color:"#111827",margin:0,lineHeight:1.8,whiteSpace:"pre-wrap"}}>{m.text}</p>
                    {m.recs && m.recs.length>0 && (
                      <div style={{marginTop:10}}>
                        <p style={{fontSize:11,color:"#9CA3AF",margin:"0 0 6px",fontWeight:500}}>{m.recs.length} employees identified</p>
                        {m.recs.slice(0,3).map(function(r,ri){
                          return (
                            <div key={ri} style={{display:"flex",alignItems:"center",gap:7,padding:"6px 10px",background:"#F9FAFB",borderRadius:7,marginBottom:4,border:"1px solid #F3F4F6"}}>
                              <Av initials={(emps.find(function(e){ return e.id===r.id; })||{}).initials||(r.name||"?").slice(0,2)} size={22} idx={ri} />
                              <div style={{flex:1,minWidth:0}}>
                                <span style={{fontSize:12,fontWeight:500,color:"#111827"}}>{r.name}</span>
                                <span style={{fontSize:11,color:"#6B7280",marginLeft:5}}>{r.role}</span>
                              </div>
                              {r.confidence && <Conf score={r.confidence} />}
                            </div>
                          );
                        })}
                        {m.recs.length>3 && <p style={{fontSize:11,color:"#9CA3AF",margin:"4px 0 0",paddingLeft:2}}>+{m.recs.length-3} more in the right panel</p>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {loading && (
              <div style={{display:"flex",gap:10,marginBottom:18}}>
                <div style={{width:26,height:26,borderRadius:7,background:"#1a1a2e",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <span style={{color:"#fff",fontSize:9,fontWeight:700}}>G</span>
                </div>
                <div style={{padding:"10px 14px",background:"#F9FAFB",borderRadius:10,border:"1px solid #F3F4F6"}}>
                  <Dots />
                </div>
              </div>
            )}
          </div>

          <div style={{padding:"10px 16px 14px",borderTop:"1px solid #F3F4F6",flexShrink:0}}>
            <ChatBar value={input} onChange={function(e){ setInput(e.target.value); }}
              onKeyDown={function(e){ if(e.key==="Enter"&&!e.shiftKey&&!loading) send(); }}
              onSend={send} loading={loading} placeholder="Ask Gaura anything, or attach files..."
              files={fu.files} onAddFiles={fu.addFiles} onRemoveFile={fu.remove} />
          </div>
        </div>

        {/* RIGHT — Workspace */}
        <div style={{flex:1,display:"flex",flexDirection:"column",background:"#FAFAFA",overflow:"hidden"}}>
          <div style={{display:"flex",borderBottom:"1px solid #F3F4F6",background:"#fff",overflowX:"auto",flexShrink:0,padding:"0 4px"}}>
            {STEPS.map(function(step) {
              var s = stepStatus[step.id]||"not_started";
              var isA = activePanel===step.id;
              return (
                <button key={step.id} onClick={function(){ setActivePanel(step.id); }}
                  style={{display:"flex",alignItems:"center",gap:5,padding:"12px 14px",border:"none",
                    background:"transparent",cursor:"pointer",whiteSpace:"nowrap",
                    borderBottom:"2px solid "+(isA?"#1a1a2e":"transparent"),
                    color:isA?"#111827":"#9CA3AF",fontSize:12,fontWeight:isA?600:400,transition:"color 0.15s"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",flexShrink:0,background:dotC[s]}} />
                  {step.label}
                </button>
              );
            })}
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"24px 28px"}}>
            {renderPanel()}
          </div>
        </div>

      </div>
      {showAdd && (
      <AddPersonModal
        candidates={recs.filter(function(r){ return !sel.find(function(s){ return s.id===r.id; }); })}
        onAdd={function(emp){ addManual(emp); }}
        onClose={function(){ setShowAdd(false); }}
      />
    )}
    </div>
  );
}

// ── APP ────────────────────────────────────────────────────────────────────────


// ── LANDING PAGE (separate component so hooks are never conditional) ──────────

function Landing(props) {
  var onExplore = props.onExplore;
  var onCreate = props.onCreate;
  var campaigns = props.campaigns;
  var onOpen = props.onOpen;
  var onDelete = props.onDelete;

  var [showNew, setShowNew] = useState(false);
  var [newName, setNewName] = useState("");
  var [confirmDelete, setConfirmDelete] = useState(null);
  var newRef = useRef(null);

  useEffect(function(){
    if (showNew && newRef.current) newRef.current.focus();
  }, [showNew]);

  function submit() {
    if (!newName.trim()) return;
    onCreate({name:newName.trim()});
    setShowNew(false);
    setNewName("");
  }

  function timeAgo(ts) {
    if (!ts) return "";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d/60000) + "m ago";
    if (d < 86400000) return Math.floor(d/3600000) + "h ago";
    return Math.floor(d/86400000) + "d ago";
  }

  return (
    <div style={{fontFamily:"'DM Sans','Helvetica Neue',sans-serif",minHeight:"100vh",background:"#F9FAFB"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Serif+Display&display=swap" rel="stylesheet" />
      <div style={{background:"#fff",borderBottom:"1px solid #E5E7EB",padding:"0 40px",height:56,display:"flex",alignItems:"center",gap:10}}>
        <Logo size={28} />
        <span style={{fontSize:15,fontWeight:600,color:"#111827"}}>Gaura</span>
        <span style={{fontSize:11,color:"#6B7280",background:"#F3F4F6",padding:"2px 8px",borderRadius:10}}>AI Insight Platform</span>
      </div>

      <div style={{maxWidth:860,margin:"0 auto",padding:"56px 24px 40px"}}>
        <p style={{fontFamily:"'DM Serif Display',serif",fontSize:28,color:"#111827",margin:"0 0 8px",letterSpacing:-0.5}}>What do you need to understand?</p>
        <p style={{fontSize:15,color:"#6B7280",margin:"0 0 48px"}}>Gaura identifies who inside your organisation holds the answer.</p>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:52}}>
          <div onClick={onExplore}
            style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:14,padding:"28px 26px",cursor:"pointer"}}
            onMouseEnter={function(e){ e.currentTarget.style.borderColor="#1a1a2e"; }}
            onMouseLeave={function(e){ e.currentTarget.style.borderColor="#E5E7EB"; }}>
            <div style={{width:40,height:40,background:"#EFF6FF",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="1.8">
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
              </svg>
            </div>
            <p style={{fontSize:15,fontWeight:600,color:"#111827",margin:"0 0 6px"}}>Explore</p>
            <p style={{fontSize:13,color:"#6B7280",margin:0,lineHeight:1.6}}>Ask the AI, upload employee files, and get instant interview recommendations — no setup needed.</p>
          </div>

          <div onClick={function(){ setShowNew(true); }}
            style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:14,padding:"28px 26px",cursor:"pointer"}}
            onMouseEnter={function(e){ e.currentTarget.style.borderColor="#1a1a2e"; }}
            onMouseLeave={function(e){ e.currentTarget.style.borderColor="#E5E7EB"; }}>
            <div style={{width:40,height:40,background:"#F0FDF4",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="1.8">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </div>
            <p style={{fontSize:15,fontWeight:600,color:"#111827",margin:"0 0 6px"}}>New campaign</p>
            <p style={{fontSize:13,color:"#6B7280",margin:0,lineHeight:1.6}}>Organise a structured investigation with guides, interviews, and a final insight report.</p>
          </div>
        </div>

        {campaigns.length > 0 && (
          <div>
            <p style={{fontSize:11,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.7,marginBottom:12}}>Campaigns</p>
            {campaigns.map(function(c,i) {
              var isConfirming = confirmDelete===c.id;
              return (
                <div key={c.id}
                  style={{background:"#fff",border:"1px solid "+(isConfirming?"#FECACA":"#E5E7EB"),
                    borderRadius:10,padding:"14px 18px",
                    display:"flex",alignItems:"center",gap:14,marginBottom:8,transition:"border-color 0.15s"}}
                  onMouseEnter={function(e){ if(!isConfirming) e.currentTarget.style.borderColor="#D1D5DB"; }}
                  onMouseLeave={function(e){ if(!isConfirming) e.currentTarget.style.borderColor="#E5E7EB"; }}>

                  <div onClick={function(){ if(!isConfirming) onOpen(c.id); }}
                    style={{display:"flex",alignItems:"center",gap:14,flex:1,cursor:isConfirming?"default":"pointer"}}>
                    <div style={{width:36,height:36,borderRadius:9,
                      background:isConfirming?"#FEF2F2":AVCOLORS[i%AVCOLORS.length],
                      display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,
                      fontWeight:600,color:isConfirming?"#DC2626":AVTXT[i%AVTXT.length],flexShrink:0}}>
                      {c.name[0]}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <p style={{fontSize:14,fontWeight:500,color:isConfirming?"#DC2626":"#111827",margin:0}}>{c.name}</p>
                      <p style={{fontSize:12,color:"#9CA3AF",margin:0}}>
                        {isConfirming
                          ? "This will permanently delete the campaign and all its data."
                          : ((c.stepSummary || "New campaign") + (c.updatedAt ? (" — " + timeAgo(c.updatedAt)) : ""))
                        }
                      </p>
                    </div>
                  </div>

                  {isConfirming ? (
                    <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                      <button
                        onClick={function(e){ e.stopPropagation(); onDelete(c.id); setConfirmDelete(null); }}
                        style={{background:"#DC2626",color:"#fff",border:"none",borderRadius:7,
                          padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer"}}>
                        Delete
                      </button>
                      <button
                        onClick={function(e){ e.stopPropagation(); setConfirmDelete(null); }}
                        style={{background:"none",color:"#6B7280",border:"1px solid #E5E7EB",
                          borderRadius:7,padding:"6px 12px",fontSize:12,cursor:"pointer"}}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={function(e){ e.stopPropagation(); setConfirmDelete(c.id); }}
                      style={{background:"none",border:"none",cursor:"pointer",color:"#D1D5DB",
                        padding:"6px 8px",lineHeight:1,borderRadius:6,flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}
                      onMouseEnter={function(e){ e.currentTarget.style.color="#9CA3AF"; e.currentTarget.style.background="#F9FAFB"; }}
                      onMouseLeave={function(e){ e.currentTarget.style.color="#D1D5DB"; e.currentTarget.style.background="none"; }}
                      title="Delete campaign">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                        <path d="M10 11v6M14 11v6"/>
                        <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showNew && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.3)",zIndex:200,
          display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={function(e){ if(e.target===e.currentTarget){ setShowNew(false); setNewName(""); } }}>
          <div style={{background:"#fff",borderRadius:14,padding:"28px 28px 24px",width:380,
            border:"1px solid #E5E7EB",boxShadow:"0 8px 32px rgba(0,0,0,0.12)"}}>
            <p style={{fontSize:17,fontWeight:600,color:"#111827",margin:"0 0 20px"}}>Name your campaign</p>
            <input ref={newRef} value={newName}
              onChange={function(e){ setNewName(e.target.value); }}
              onKeyDown={function(e){
                if (e.key==="Enter") submit();
                if (e.key==="Escape"){ setShowNew(false); setNewName(""); }
              }}
              placeholder="e.g. London Complaints Investigation"
              style={{width:"100%",boxSizing:"border-box",border:"1px solid #E5E7EB",borderRadius:8,
                padding:"11px 14px",fontSize:14,background:"#fff",color:"#111827",
                outline:"none",marginBottom:16}} />
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={function(){ setShowNew(false); setNewName(""); }}
                style={{padding:"9px 16px",borderRadius:8,border:"1px solid #E5E7EB",
                  background:"transparent",fontSize:13,cursor:"pointer",color:"#6B7280"}}>
                Cancel
              </button>
              <button onClick={submit} disabled={!newName.trim()}
                style={{padding:"9px 18px",borderRadius:8,border:"none",background:"#1a1a2e",
                  color:"#fff",fontSize:13,fontWeight:500,cursor:"pointer",
                  opacity:newName.trim()?1:0.4}}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── APP (all hooks at top, no hooks after conditional returns) ─────────────────

export default function App() {
  var [view, setView] = useState("loading");
  var [campaigns, setCampaigns] = useState([]);
  var [active, setActive] = useState(null);

  // Load campaign index on mount
  useEffect(function() {
    async function load() {
      try {
        var idx = await storeLoad("campaign-index");
        if (idx && Array.isArray(idx)) setCampaigns(idx);
      } catch(e) {}
      setView("landing");
    }
    load();
  }, []);

  async function saveCampaignIndex(list) {
    await storeSave("campaign-index", list.map(function(c){
      return {id:c.id, name:c.name, updatedAt:c.updatedAt||Date.now(), stepSummary:c.stepSummary||""};
    }));
  }

  async function create(data) {
    var c = {id:Date.now(), name:data.name, updatedAt:Date.now(), stepSummary:"Just created"};
    var next = [c].concat(campaigns);
    setCampaigns(next);
    await saveCampaignIndex(next);
    setActive(c);
    setView("campaign");
  }

  function open(id) {
    var c = campaigns.find(function(x){ return x.id===id; });
    if (c) { setActive(c); setView("campaign"); }
  }

  async function deleteCampaign(id) {
    await storeDelete("campaign-" + id);
    var next = campaigns.filter(function(c){ return c.id!==id; });
    setCampaigns(next);
    await saveCampaignIndex(next);
  }

  function handleCampaignSave(id, state) {
    setCampaigns(function(prev) {
      var next = prev.map(function(c) {
        if (c.id!==id) return c;
        var stepDone = Object.values(state.stepStatus||{}).filter(function(v){ return v==="complete"; }).length;
        var stepSummary = state.q
          ? (stepDone + "/8 — " + state.q.slice(0,40) + (state.q.length>40?"...":""))
          : stepDone + "/8 steps";
        return Object.assign({}, c, {updatedAt:Date.now(), stepSummary:stepSummary});
      });
      saveCampaignIndex(next);
      return next;
    });
  }

  // Loading screen
  if (view==="loading") {
    return (
      <div style={{fontFamily:"'DM Sans',sans-serif",height:"100vh",display:"flex",
        alignItems:"center",justifyContent:"center",background:"#fff"}}>
        <div style={{textAlign:"center"}}>
          <Logo size={36} />
          <p style={{fontSize:14,color:"#9CA3AF",marginTop:12}}>Loading...</p>
        </div>
      </div>
    );
  }

  if (view==="explore") {
    return <Explore onBack={function(){ setView("landing"); }} />;
  }

  if (view==="campaign" && active) {
    return <Campaign init={active} onBack={function(){ setView("landing"); }} onSave={handleCampaignSave} />;
  }

  return (
    <Landing
      onExplore={function(){ setView("explore"); }}
      onCreate={create}
      campaigns={campaigns}
      onOpen={open}
      onDelete={deleteCampaign}
    />
  );
}
