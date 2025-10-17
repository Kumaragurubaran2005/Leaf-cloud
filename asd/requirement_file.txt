from graphviz import Digraph
import os

# Ensure Graphviz executable is found (Windows)
os.environ["PATH"] += os.pathsep + r"C:\Program Files\Graphviz\bin"

# Create a directed graph
org_chart = Digraph("Organizational_Hierarchy", format="png")
org_chart.attr(rankdir="TB", size="12,10")  # bigger canvas
org_chart.attr(dpi="300")                   # high resolution
org_chart.attr(nodesep="0.8", ranksep="1.2")  # more spacing

# 1️⃣ Top Management
org_chart.node("CEO", "Founder / CEO", shape="box", style="filled", fillcolor="lightblue")
org_chart.node("COO", "Co-Founder / COO", shape="box", style="filled", fillcolor="lightblue")

# 2️⃣ Technology & Product
org_chart.node("CTO", "CTO", shape="box", style="filled", fillcolor="lightgreen")
org_chart.node("Backend", "Backend Developers", shape="box")
org_chart.node("Frontend", "Frontend Developers", shape="box")
org_chart.node("Mobile", "Mobile Developers", shape="box")
org_chart.node("Hardware", "Hardware Integration Engineer", shape="box")
org_chart.node("DevOps", "DevOps / System Admin", shape="box")

# 3️⃣ Data Security & Compliance
org_chart.node("CISO", "CISO (Security)", shape="box", style="filled", fillcolor="orange")
org_chart.node("DPO", "Data Protection Officer", shape="box")

# 4️⃣ Operations & Project Delivery
org_chart.node("PM", "Project Manager", shape="box", style="filled", fillcolor="pink")
org_chart.node("QA", "QA / Test Engineers", shape="box")

# 5️⃣ Business & Partnerships
org_chart.node("BD", "Business Development Manager", shape="box", style="filled", fillcolor="yellow")
org_chart.node("Legal", "Legal & Compliance Officer", shape="box")
org_chart.node("Finance", "Finance & Accounts", shape="box")

# 6️⃣ Support & Maintenance
org_chart.node("Support", "Technical Support Team", shape="box", style="filled", fillcolor="violet")
org_chart.node("Field", "Training & Field Staff", shape="box")

# 🔗 Define hierarchy
org_chart.edges([("CEO", "COO"), ("CEO", "CTO"), ("CEO", "CISO"), ("CEO", "BD")])
org_chart.edges([("CTO", "Backend"), ("CTO", "Frontend"), ("CTO", "Mobile"), ("CTO", "Hardware"), ("CTO", "DevOps")])
org_chart.edge("CISO", "DPO")
org_chart.edges([("COO", "PM"), ("PM", "QA")])
org_chart.edges([("BD", "Legal"), ("BD", "Finance")])
org_chart.edges([("COO", "Support"), ("Support", "Field")])

# Render high-resolution chart
file_path = "org_hierarchy_biometric_voting_highres"
org_chart.render(file_path)

print(f"Flowchart saved as {file_path}.png (high resolution)")
