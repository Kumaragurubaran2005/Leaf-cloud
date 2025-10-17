import { useState } from "react";

function Resourceproviders()
{
    const [isTaskAvailable,setisTaskAvailable] =useState(false)
    const [workerId,setworkerId] = useState("") 
    const [isworking,setworking] = useState(false)
    const askfortask =async()=>
    {
        try{
            const response = await fetch("http://localhost:5000/askfortask")
            const data =await response.json()
            if(data.isTaskThere)
            {
                setisTaskAvailable(true)
            }
            
        }
        catch(err)
        {
            alert(err)
        }
    }
    const iamin = async()=>
    {
        try{
            const response =await fetch("http://localhost:5000/iamin",{
                method:"POST", 
                headers: {"Content-Type": "application/json",},
                body: JSON.stringify({ workerId }),
            })
            const data =await response.json()
            if (data.isaccepted)
            {
                setworking(true)
                alert("you are in")
            }

        }
        catch(err)
        {
            alert(err)
        }
    }
    const getfiles = async()=>
    {
        try{
            const response = await fetch("http://localhost:5000/getfiles")
        }
    }

}
export default Resourceproviders;